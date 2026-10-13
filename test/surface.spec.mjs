/**
 * What the drop does to a surface.
 *
 * The three properties asserted here are the ones that make a drop safe rather
 * than merely smaller: the system head survives, no tool-call/tool-result pair is
 * split, and the retained tail is priced the way the shipped producers price one.
 * The session itself validates the first two on every append, so these arms are a
 * second witness on top of the shipped predicates — they assert the *shape of the
 * surface*, not that no exception was thrown.
 *
 * @module test/surface
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  eventsOfType,
  surfaceMessageAt,
  surfaceSeqs,
  textOf,
  unansweredToolCalls,
  agentFor,
  overflowFailure,
  world,
} from './harness.mjs'
import { commitRecovery, NOTICE_PREAMBLE, planRecovery } from '../lib/recover.js'

/** A configuration whose retained tail is small enough that the fixture has room to drop. */
const DROPPABLE = { retainTokens: 2_000, retainMinNodes: 2 }

/** Every surface node the replacement shadowed, read back from the durable log. */
function shadowedSeqs(session) {
  return eventsOfType(session, 'compaction/prune').flatMap(event => [...event.data.shadowedSeqs])
}

/**
 * The surface position the retention budget ALONE would keep first.
 *
 * This is the cut the balanced-cut rule exists to move, computed here so the arm
 * that depends on the two disagreeing can assert that they do. It deliberately
 * mirrors only the budget half of the selection: a fixture whose budget already
 * lands on a balanced position would let the rule be deleted unnoticed.
 * @param ctx - the world's context, for the meter.
 * @param session - the fixture to price.
 * @param settings - the retention budget to walk backwards with.
 * @returns the surface index the budget alone would retain first.
 */
function naiveRetainIndex(ctx, session, settings) {
  const nodes = ctx.tokenMeter.measure(session).nodes
  let accumulated = 0
  let keepFrom = nodes.length
  for (let index = nodes.length - 1; index >= 1; index -= 1) {
    accumulated += nodes[index].tokens
    keepFrom = index
    if (nodes.length - index >= settings.retainMinNodes && accumulated >= settings.retainTokens) break
  }
  return keepFrom
}

describe('the shape of a recovered surface', () => {
  it('keeps the system message at surface node 0', async () => {
    const { conversation, toolConversation, recover } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })
    const head = surfaceSeqs(session)[0]

    await recover(agentFor(session), overflowFailure())

    assert.equal(surfaceSeqs(session)[0], head)
    assert.match(textOf(surfaceMessageAt(session, 0)), /You are a harness fixture\./)
    assert.equal(shadowedSeqs(session).includes(head), false)
  })

  it('replaces the dropped prefix with exactly one message, in its place', async () => {
    const { conversation, toolConversation, recover } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })
    const before = surfaceSeqs(session)

    await recover(agentFor(session), overflowFailure())

    const after = surfaceSeqs(session)
    assert.equal(after.length, before.length - shadowedSeqs(session).length + 1)
    const notice = surfaceMessageAt(session, 1)
    assert.equal(notice.source.kind, 'overflow-recovery')
    assert.equal(notice.source.form, 'notice')
    assert.match(textOf(notice), new RegExp(NOTICE_PREAMBLE.replace('.', '\\.')))
    assert.match(textOf(notice), new RegExp(`${shadowedSeqs(session).length} earlier surface messages`))
  })

  it('leaves the retained tail byte-identical and in order', async () => {
    const { conversation, toolConversation, recover } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })
    const before = surfaceSeqs(session)

    await recover(agentFor(session), overflowFailure())

    const after = surfaceSeqs(session)
    const retained = after.slice(2)
    assert.deepEqual(retained, before.slice(before.length - retained.length))
  })

  it('moves the cut back when the token budget alone would land mid-pair', async () => {
    // A retention budget one node past the balanced cut. The token budget alone
    // would retain from a `tool` node, whose call sits at the position just before
    // it and would be shadowed on its own — the orphan-`tool/call` shape. The
    // balanced-cut rule is the only thing that moves the cut back.
    const RETAIN = { retainTokens: 3_000, retainMinNodes: 2 }
    const { toolConversation, ctx, recover } = await world({ config: RETAIN })
    const session = toolConversation({ turns: 6 })

    // The arm's precondition, asserted rather than assumed: the position the token
    // budget alone would retain first is a tool result, so removing the balance rule
    // changes the answer. A fixture that was already balanced here would make this
    // arm silent.
    const naive = naiveRetainIndex(ctx, session, RETAIN)
    assert.equal(surfaceMessageAt(session, naive).role, 'tool')

    await recover(agentFor(session), overflowFailure())

    assert.equal(unansweredToolCalls(session), 0)
    // Position 1 is the notice; the retained tail begins at 2, and it begins with
    // the assistant that owns the call the next position answers — the balance rule
    // moved the cut back onto the pair rather than between its halves.
    assert.equal(surfaceMessageAt(session, 2).role, 'assistant')
    assert.equal(surfaceMessageAt(session, 3).role, 'tool')
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
  })

  it('never splits a tool-call from its result', async () => {
    const { conversation, toolConversation, recover } = await world({ config: DROPPABLE })
    const session = toolConversation({ turns: 6 })
    assert.equal(unansweredToolCalls(session), 0)

    await recover(agentFor(session), overflowFailure())

    assert.equal(unansweredToolCalls(session), 0)
    assert.ok(eventsOfType(session, 'compaction/prune').length === 1)
    // The cut is only legal before a surface node whose leading cut is balanced, so
    // the replacement must not sit between a call and its answer.
    assert.notEqual(surfaceMessageAt(session, 1).role, 'tool')
  })

  it('drops whole pairs, so the log keeps the calls it no longer shows', async () => {
    const { conversation, toolConversation, recover } = await world({ config: DROPPABLE })
    const session = toolConversation({ turns: 6 })
    const callsBefore = session.snapshotEvents().filter(event => event.type === 'tool/call').length

    await recover(agentFor(session), overflowFailure())

    // Nothing is deleted: only the surface changed.
    assert.equal(session.snapshotEvents().filter(event => event.type === 'tool/call').length, callsBefore)
    assert.ok(surfaceSeqs(session).length < 19)
  })
})

describe('the pair the drop appends', () => {
  it('writes the shadow price immediately before its replacement', async () => {
    const { conversation, toolConversation, recover } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })

    await recover(agentFor(session), overflowFailure())

    const events = session.snapshotEvents()
    const replacement = events.find(event => event.type === 'user/message'
      && event.surfaceOp?.op === 'replace')
    const index = events.indexOf(replacement)
    assert.equal(events[index - 1].type, 'compaction/prune')
    assert.deepEqual(replacement.surfaceOp, {
      op: 'replace',
      startSeq: events[index - 1].data.shadowedRange.start,
      endSeq: events[index - 1].data.shadowedRange.end,
    })
  })

  it('cites the shadow price and every shadowed node, so the session can verify the range', async () => {
    const { conversation, toolConversation, recover } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })

    await recover(agentFor(session), overflowFailure())

    const events = session.snapshotEvents()
    const prune = events.find(event => event.type === 'compaction/prune')
    const replacement = events.find(event => event.type === 'user/message' && event.surfaceOp?.op === 'replace')
    assert.deepEqual([...replacement.sourceEventSeqs], [prune.seq, ...prune.data.shadowedSeqs])
  })

  it('prices the dropped span and the retained tail by the route, the shadow claim by the heuristic', async () => {
    const { conversation, toolConversation, ctx, recover } = await world({ config: DROPPABLE })
    // Images on the first and the last turn: the first lands inside the dropped
    // prefix and the last inside the retained tail, so BOTH quantities have a node
    // whose route price and fixed heuristic price differ. Without one, reading the
    // wrong field is invisible and this arm would prove nothing.
    const session = conversation({ turns: 6, imageTurns: [1, 6] })
    const priced = ctx.tokenMeter.measure(session).nodes
    const priceOf = (seq, field) => priced.find(node => node.seq === seq)[field]
    const sum = (seqs, field) => seqs.reduce((total, seq) => total + priceOf(seq, field), 0)
    const plan = planRecovery(session, ctx.tokenMeter, {
      mode: 'recover',
      retainTokens: DROPPABLE.retainTokens,
      retainMinNodes: DROPPABLE.retainMinNodes,
      maxRecoveries: 3,
    })

    // The precondition, asserted rather than assumed: this fixture is only worth
    // anything if the two prices really do disagree on a node of each region.
    const head = surfaceSeqs(session)[0]
    const retainedSeqs = priced.map(node => node.seq)
      .filter(seq => seq !== head && !plan.range.shadowedSeqs.includes(seq))
    for (const seqs of [plan.range.shadowedSeqs, retainedSeqs]) {
      assert.ok(seqs.some(seq => priceOf(seq, 'tokens') !== priceOf(seq, 'heuristicTokens')))
    }

    assert.equal(plan.range.droppedTokens, sum(plan.range.shadowedSeqs, 'tokens'))
    assert.equal(plan.range.retainedTokens, sum(retainedSeqs, 'tokens'))
    // The shadow claim is the one quantity the meter's O(1) fold re-derives from its
    // own appends, so it is the one priced at the fixed heuristic.
    assert.equal(plan.range.shadowedTokenCount, sum(plan.range.shadowedSeqs, 'heuristicTokens'))

    const outcome = commitRecovery(session, plan)
    assert.equal(
      eventsOfType(session, 'compaction/prune')[0].data.shadowedTokenCount,
      plan.range.shadowedTokenCount,
    )
    assert.equal(outcome.droppedNodes, plan.range.shadowedSeqs.length)
    // Redundant on purpose: the commit must not have re-priced anything.
    await recover(agentFor(session), overflowFailure())
  })
})

describe('when a drop is refused', () => {
  it('refuses when the replacement would not be smaller than the span', async () => {
    const { conversation, toolConversation, ctx } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 3, words: 2 })
    // Three tiny turns: a retained tail of two nodes beyond the head leaves one
    // droppable node, whose price is below the notice's.
    const plan = planRecovery(session, ctx.tokenMeter, {
      mode: 'recover',
      retainTokens: 0,
      retainMinNodes: 2,
      maxRecoveries: 3,
    })
    assert.equal(plan, null)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
  })

  it('refuses when the retained tail swallows the whole surface', async () => {
    const { conversation, toolConversation, ctx } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 2 })
    const plan = planRecovery(session, ctx.tokenMeter, {
      mode: 'recover',
      retainTokens: 1_000_000,
      retainMinNodes: 0,
      maxRecoveries: 3,
    })
    assert.equal(plan, null)
  })

  it('refuses a surface holding only the system head', async () => {
    const { conversation, toolConversation, ctx } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 1, words: 1 })
    const plan = planRecovery(session, ctx.tokenMeter, {
      mode: 'recover',
      retainTokens: 0,
      retainMinNodes: 0,
      maxRecoveries: 3,
    })
    assert.equal(plan, null)
  })
})
