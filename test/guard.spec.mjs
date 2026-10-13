/**
 * The decision arms: when the plugin acts, when it defers, and what it writes.
 *
 * Every arm here dispatches the real `agent/request-error` waterfall, so the value
 * asserted on is the value the agent loop would act on.
 *
 * @module test/guard
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  agentFor,
  appendExchange,
  appendPrompt,
  eventsOfType,
  namespace,
  otherFailure,
  overflowFailure,
  signal,
  surfaceSeqs,
  world,
} from './harness.mjs'

/** A configuration whose retained tail is small enough that the fixture has room to drop. */
const DROPPABLE = { retainTokens: 2_000, retainMinNodes: 2 }

describe('the decision', () => {
  it('recovers the turn when nothing else claimed the retry', async () => {
    const { conversation, recover, logs, ctx } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })
    const action = await recover(agentFor(session), overflowFailure())

    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
    assert.equal(logs.matching('dropped').length, 1)
    assert.ok(ctx.tokenMeter.measure(session).nodes.length < 13)
  })

  it('writes nothing when the plugin is not mounted', async () => {
    const { conversation, recover } = await world({ mounted: false, config: DROPPABLE })
    const session = conversation({ turns: 6 })
    const before = surfaceSeqs(session)

    assert.equal(await recover(agentFor(session), overflowFailure()), undefined)
    assert.deepEqual(surfaceSeqs(session), before)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
  })

  it('writes nothing in report mode but still logs the reduction it would have made', async () => {
    const { conversation, recover, logs } = await world({ config: { ...DROPPABLE, mode: 'report' } })
    const session = conversation({ turns: 6 })
    const before = JSON.stringify(session.snapshotEvents())

    assert.equal(await recover(agentFor(session), overflowFailure()), undefined)
    assert.equal(JSON.stringify(session.snapshotEvents()), before)
    assert.equal(logs.matching('would drop').length, 1)
    assert.equal(logs.matching('dropped ').length, 0)
  })

  it('installs no listener at all in off mode', async () => {
    const { conversation, recover, logs } = await world({ config: { ...DROPPABLE, mode: 'off' } })
    const session = conversation({ turns: 6 })

    assert.equal(await recover(agentFor(session), overflowFailure()), undefined)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    assert.equal(logs.matching('overflow-recovery:').length, 0)
  })

  it('mounts from the module namespace as well as the default export', async () => {
    const { conversation, recover } = await world({ form: 'namespace', config: DROPPABLE })
    const session = conversation({ turns: 6 })

    assert.deepEqual(await recover(agentFor(session), overflowFailure()), { kind: 'retry' })
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
  })

  it('exports nothing the Loader would read as a configuration schema', () => {
    // A plain object exported under `Config` is read as a standard-schema
    // validator by the Loader, and the plugin becomes unmountable. The namespace
    // must therefore carry no `Config` at all.
    assert.equal('Config' in namespace, false)
    assert.equal('default' in namespace, true)
    assert.deepEqual(Object.keys(namespace.default).sort(), ['apply', 'inject', 'name'])
  })
})

describe('what the plugin refuses to touch', () => {
  it('leaves a failure with another code alone', async () => {
    const { conversation, recover, logs } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })

    assert.equal(await recover(agentFor(session), otherFailure()), undefined)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    assert.equal(logs.matching('overflow-recovery:').length, 0)
  })

  it('leaves an aborted turn alone', async () => {
    const controller = new AbortController()
    controller.abort()
    const { conversation, recover } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })

    assert.equal(await recover(agentFor(session), overflowFailure(), { signal: controller.signal }), undefined)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
  })

  it('leaves an overflow alone when the surface holds nothing it may drop', async () => {
    const { conversation, recover, logs } = await world({ config: { retainTokens: 1_000_000 } })
    const session = conversation({ turns: 6 })

    assert.equal(await recover(agentFor(session), overflowFailure()), undefined)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    assert.equal(logs.matching('nothing droppable').length, 1)
  })

  it('reports a session that refused the drop rather than failing the turn with a stack trace', async () => {
    const { conversation, recover, logs } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })
    // A real refusal comes from the session's own append validation (a surface that
    // moved between pricing and committing). The arm only needs the throw, so it is
    // injected here; nothing is asserted about WHICH refusal, only that the turn
    // ends with the original overflow rather than a plugin stack trace.
    session.append = () => {
      throw new Error('surface replace: start seq 2 not found in surface')
    }

    assert.equal(await recover(agentFor(session), overflowFailure()), undefined)
    assert.equal(logs.matching('refused the drop').length, 1)
  })
})

describe('deferring to whatever else owns the retry', () => {
  for (const mountFirst of [false, true]) {
    it(`defers to a downstream retry claim (plugin mounted ${mountFirst ? 'after' : 'before'})`, async () => {
      const { conversation, recover } = await world({ config: DROPPABLE, downstream: 'claim', mountFirst })
      const session = conversation({ turns: 6 })
      const before = surfaceSeqs(session)

      assert.deepEqual(await recover(agentFor(session), overflowFailure()), { kind: 'retry' })
      assert.deepEqual(surfaceSeqs(session), before)
      assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    })
  }

  it('defers to a downstream listener that declines and passes the decision along', async () => {
    const { conversation, recover } = await world({ config: DROPPABLE, downstream: 'passes' })
    const session = conversation({ turns: 6 })

    assert.deepEqual(await recover(agentFor(session), overflowFailure()), { kind: 'retry' })
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
  })

  it('still recovers when a downstream recovery throws', async () => {
    const { conversation, recover, logs } = await world({ config: DROPPABLE, downstream: 'throws' })
    const session = conversation({ turns: 6 })

    assert.deepEqual(await recover(agentFor(session), overflowFailure()), { kind: 'retry' })
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
    assert.equal(logs.matching('downstream recovery failure').length, 1)
  })

  it('does not refuse a signal that is only aborted by the abort check itself', async () => {
    // The abort check runs after the chain: a signal that was live when the chain
    // started and aborted during it must still stop the write.
    const controller = new AbortController()
    const { conversation, ctx, recover } = await world({ config: DROPPABLE, downstream: 'passes' })
    const session = conversation({ turns: 6 })
    ctx.on('agent/request-error', () => {
      controller.abort()
      return Promise.resolve(undefined)
    })

    assert.equal(await recover(agentFor(session), overflowFailure(), { signal: controller.signal }), undefined)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
  })
})

describe('the bound on repeated recovery', () => {
  it('stops claiming the retry after maxRecoveries, and says so', async () => {
    const { conversation, recover, logs } = await world({
      config: { retainTokens: 0, retainMinNodes: 2, maxRecoveries: 1 },
    })
    const session = conversation({ turns: 6 })
    const agent = agentFor(session)

    assert.deepEqual(await recover(agent, overflowFailure()), { kind: 'retry' })
    // The bound counts attempts to un-wedge ONE incident, and the incident ends
    // when the session answers a request again — so the second overflow is grown
    // with an unanswered prompt. Appending a completed exchange here would answer
    // it, reset the bound, and measure the other arm instead of this one.
    appendPrompt(session, 90)
    appendPrompt(session, 91)

    assert.equal(await recover(agent, overflowFailure()), undefined)
    assert.equal(logs.matching('recoveries already performed').length, 1)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
  })

  it('forgets the count once the session answers a request again', async () => {
    const { conversation, recover } = await world({
      config: { retainTokens: 0, retainMinNodes: 2, maxRecoveries: 1 },
    })
    const session = conversation({ turns: 6 })
    const agent = agentFor(session)

    assert.deepEqual(await recover(agent, overflowFailure()), { kind: 'retry' })
    // The same two overflows as the arm above, except that a committed assistant
    // message here IS the session answering again — which ends the incident and
    // returns the budget. The two arms are the same experiment with one difference.
    appendExchange(session, 90)
    appendExchange(session, 91)

    assert.deepEqual(await recover(agent, overflowFailure()), { kind: 'retry' })
    assert.equal(eventsOfType(session, 'compaction/prune').length, 2)
  })

  it('never counts a refusal against the bound', async () => {
    const { conversation, recover } = await world({ config: { retainTokens: 1_000_000, maxRecoveries: 1 } })
    const session = conversation({ turns: 6 })
    const agent = agentFor(session)

    assert.equal(await recover(agent, overflowFailure()), undefined)
    assert.equal(await recover(agent, overflowFailure()), undefined)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
  })

  it('cancels an unparseable bound back to the default rather than failing to mount', async () => {
    const { conversation, recover } = await world({
      config: { retainTokens: Number.NaN, retainMinNodes: -4, maxRecoveries: Number.POSITIVE_INFINITY },
    })
    // The defaults are the shipped ones — retainTokens 24000, retainMinNodes 4,
    // maxRecoveries 3 — so the fixture has to be big enough for a droppable prefix
    // to exist under a 24000-token retained tail. At the default 6 turns the whole
    // conversation fits inside that tail, and the arm would then be asserting on a
    // refusal rather than on the fallback it is about.
    const session = conversation({ turns: 60 })

    assert.deepEqual(await recover(agentFor(session), overflowFailure()), { kind: 'retry' })
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
  })

  it('refuses to mount on an unrecognised mode', async () => {
    await assert.rejects(
      () => world({ config: { mode: 'repaire' } }),
      /mode must be one of recover, report, off/,
    )
  })

  it('leaves a fresh signal untouched by the default', async () => {
    const { conversation, recover } = await world({ config: DROPPABLE })
    const session = conversation({ turns: 6 })
    assert.deepEqual(await recover(agentFor(session), overflowFailure(), { signal: signal() }), { kind: 'retry' })
  })
})
