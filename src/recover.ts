/**
 * The durable, model-free reduction that un-wedges an overflowing session.
 *
 * ## What a committed recovery does to a session
 *
 * One surface replacement, in the shape the shipped producers use:
 *
 * ```text
 * compaction/prune     shadowedRange, shadowedSeqs, shadowedTokenCount
 * user/message         surfaceOp: { op: 'replace', startSeq, endSeq }
 *                      sourceEventSeqs: [pruneSeq, ...shadowedSeqs]
 * ```
 *
 * The two appends are synchronous and adjacent because the token meter's surface
 * fold reads them that way (`@deepseek-ai/dsh-token-meter/surface-projection`): a
 * shadow-price event arms a claim for the very next event, and a replacement
 * consumes it — `deltaTokens = tokens - claim.tokens`. A replacement with no
 * adjacent claim folds with a **zero** delta, which would leave the pressure
 * estimate holding the price of content that is no longer sent. The claim is
 * therefore not decoration: without it the recovery would shrink the request and
 * not the estimate.
 *
 * The prices come from the meter, never from arithmetic done here: the shadow
 * price is the sum of the dropped nodes' `heuristicTokens` and the retained
 * budget is the sum of their `tokens`, exactly the two quantities
 * `prepareCompaction` uses (`@deepseek-ai/dsh-compaction-basic/src/region.ts`).
 *
 * ## Planning and committing are separate
 *
 * `planRecovery` prices the drop and decides whether to make it, and writes
 * nothing; `commitRecovery` performs it. `report` mode calls only the first, which
 * is what makes that mode's promise — "writes nothing and logs the reduction
 * `recover` would have made" — a property of the code rather than of the wording.
 *
 * ## What it does not do
 *
 * It does not summarize, does not call a model, and does not delete history: the
 * dropped events stay in the log and a replay can still read them — only the
 * model-visible surface changes. It also cannot help when the overflowing content
 * is not in the middle of the surface (the system prompt and tool definitions are
 * not droppable by anyone), which is why the caller bounds the number of attempts
 * per incident.
 *
 * @module @argszero/dsh-overflow-recovery/recover
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Settings } from './config.ts'
import { selectDropRange } from './select.ts'
import type { DropRange } from './select.ts'

/**
 * The source kind of the notice a recovery writes.
 *
 * `MessageSourceMap` is merge-extensible — each producer declares its own kind and
 * there is no shared catch-all — so this plugin owns the name rather than
 * borrowing one. The `notice` form is the one whose shape matches what happened: a
 * one-line account shown without expanding the row.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A deterministic overflow recovery dropped earlier surface content. */
    'overflow-recovery': { readonly kind: 'overflow-recovery' } & ContextFormed
  }
}

/** A drop this plugin has priced and decided to make, but not yet made. */
export interface RecoveryPlan {
  /** The dropped range and its prices. */
  readonly range: DropRange
  /** The message that will stand in for the dropped range. */
  readonly notice: UserMessage
  /** Estimated tokens of that message. */
  readonly replacementTokens: number
}

/** What one committed recovery changed, for the caller's log line and for its own bookkeeping. */
export interface RecoveryOutcome extends RecoveryPlan {
  /** Seq of the appended shadow-price event. */
  readonly pruneSeq: SessionSeq
  /** Seq of the appended replacement. */
  readonly replacementSeq: SessionSeq
  /** Number of surface nodes the replacement shadowed. */
  readonly droppedNodes: number
}

/** The notice preamble, kept out of the rendering so an arm can assert on it. */
export const NOTICE_PREAMBLE = 'Earlier conversation was dropped from the visible history.'

/**
 * Price the oldest droppable region of the surface and decide whether to drop it.
 *
 * Pure: it reads the session and returns a plan. Nothing is appended, so a caller
 * that only wants to know the size of the reduction — `report` mode — can ask
 * without changing anything.
 *
 * @param session - session whose surface would be reduced.
 * @param meter - the token meter, the only pricer used here.
 * @param settings - retention bounds.
 * @returns the plan, or `null` when this session offers no legal drop (nothing
 *   droppable, or the replacement would not be smaller).
 */
export function planRecovery(session: Session, meter: TokenMeter, settings: Settings): RecoveryPlan | null {
  const measurement = meter.measure(session)
  const range = selectDropRange(session, measurement.nodes, settings)
  if (range === null) return null

  const notice = createUserMessage({
    content: [{ type: 'text', text: renderNotice(range, settings) }],
    source: {
      kind: 'overflow-recovery',
      form: 'notice',
      summary: boundContextSummary(
        `context window exceeded — dropped ${range.shadowedSeqs.length} earlier messages without a summary`,
      ),
    },
  })
  const replacementTokens = meter.estimateMessage(notice)
  // A replacement that is not smaller would trade one overflow for the same
  // overflow and spend the incident's retry doing it — the shipped compaction
  // refuses the same way when its summary does not shrink the span.
  if (replacementTokens >= range.droppedTokens) return null
  return { range, notice, replacementTokens }
}

/**
 * Make the drop durable.
 *
 * The two appends are synchronous and adjacent: the shadow-price protocol is a
 * property of adjacent events, not of two events that happen to be near each
 * other, so nothing may be awaited between them.
 *
 * @param session - the session the plan was priced against; it must not have
 *   changed since.
 * @param plan - the plan to commit.
 * @returns what was written.
 * @throws whatever the session's own append validation throws — the caller
 *   decides what to do with a write the session refused.
 */
export function commitRecovery(session: Session, plan: RecoveryPlan): RecoveryOutcome {
  const { range, notice, replacementTokens } = plan
  const prune = session.append('compaction/prune', {
    shadowedRange: { start: range.start, end: range.end },
    shadowedSeqs: [...range.shadowedSeqs],
    shadowedTokenCount: range.shadowedTokenCount,
  })
  const replacement = session.append('user/message', notice, {
    surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
    sourceEventSeqs: [prune.seq, ...range.shadowedSeqs],
  })
  return {
    ...plan,
    pruneSeq: prune.seq,
    replacementSeq: replacement.seq,
    droppedNodes: range.shadowedSeqs.length,
    replacementTokens,
  }
}

/**
 * Render the notice that stands in for the dropped region.
 *
 * It is written for a model reading the surface, not for a log reader: it says
 * what is missing, that it is gone rather than summarized, and what to do about
 * it. The numbers are the harness's own estimates and are named as estimates,
 * because a route's real prompt is what the provider counted, not this.
 * @param range - the dropped span.
 * @param settings - resolved bounds, for the retained-tail budget in the text.
 * @returns the notice text.
 */
function renderNotice(range: DropRange, settings: Settings): string {
  const dropped = range.shadowedSeqs.length
  return `${NOTICE_PREAMBLE}\n\n`
    + 'This request exceeded the model\'s context window, and no summary of the earlier '
    + 'conversation could be produced — summarizing replays the same oversized history '
    + 'to the same model, so recovery by summarization was not available.\n\n'
    + `${dropped} earlier surface message${dropped === 1 ? '' : 's'} `
    + `(~${range.droppedTokens} tokens by this harness's estimate) were removed from the `
    + 'history sent to you. The messages after this notice are the retained recent '
    + `context (at least ~${settings.retainTokens} estimated tokens).\n\n`
    + 'They were dropped, not summarized: nothing of their content survives in the '
    + 'request, and the user can still see the full conversation. If you need anything '
    + 'from it, ask the user rather than guessing.'
}
