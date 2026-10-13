/**
 * A session whose request exceeds the model's context window, and whose
 * summarizer cannot fit that same window, has no way out: every later message
 * replays the same oversized history and fails the same 400, so the session is
 * unusable until someone edits the persisted log by hand.
 *
 * ## The defect
 *
 * Two of the three mechanisms behind that dead end are core, and this plugin
 * does not pretend to fix them: the surface-token estimate can sit below what
 * the provider actually counts, and the summarizer replays the very region it
 * is meant to remove through the route that just refused it. Both are algorithm
 * changes inside `@deepseek-ai/dsh-compaction-basic` and
 * `@deepseek-ai/dsh-token-meter`.
 *
 * The third is a missing capability rather than a wrong number: **nothing in
 * the product can make an oversized history smaller without a model.** The
 * shipped non-LLM reducer, `@deepseek-ai/dsh-compaction-tool-result-pruner`,
 * reaches only the middle of tool-result text — not the user and assistant text
 * that dominates a long session. So when summarization is exactly what cannot
 * fit, there is no fallback to fall back to. Discussion #9635 is that report,
 * and it reproduces the dead end: one automatic attempt and three manual
 * `/compact`s failing identically, then every subsequent message (including a
 * bare `?`) failing the same way.
 *
 * ## What this plugin does
 *
 * It joins `agent/request-error` and **waits**: it calls `next()` first, so
 * whichever listener owns the retry — the shipped compaction engine, a provider
 * retry, another plugin — decides before this one. Only when the chain returns
 * no decision at all (nothing claimed the retry, the ordinary outcome once the
 * overflow budget is spent or the summarizer has failed) does this plugin drop
 * the oldest droppable region of the model-visible surface and let the loop
 * retry.
 *
 * Deciding **after** `next()` is what makes listener order irrelevant: mounted
 * before or after the compaction engine, the summarizer still answers first, and
 * this plugin is reached only when that answer was "no".
 *
 * The drop is one durable replacement — a `compaction/prune` shadow price
 * immediately followed by a `user/message` carrying `surfaceOp: { op: 'replace' }`,
 * the same pair the shipped producers append — so the log keeps every dropped
 * event and only the surface changes. `recover.ts` explains why that pair cannot
 * be split; `select.ts` states the three rules the cut obeys (never the system
 * head, never a split tool-call pair, always a priced retained tail).
 *
 * ## What it is not
 *
 * It is not a summarizer, and it is not transparent: content the model would
 * otherwise have seen is gone from the request, and the notice left in its place
 * says so. It is the last resort the report asked for — anything rather than
 * replaying the full overflow into the same overflow — and the shipped
 * summarizer remains the first choice for every overflow it can handle.
 *
 * @module @argszero/dsh-overflow-recovery
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { normalizeConfig } from './config.ts'
import type { Config, Settings } from './config.ts'
import { commitRecovery, planRecovery } from './recover.ts'
import type { RecoveryPlan } from './recover.ts'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'overflow-recovery'

/**
 * The service this plugin needs: the meter that prices the surface.
 *
 * `TokenMeter` declares `inject = ['sessionProjections']` of its own, so this
 * also requires the projection registry the harness already mounts. Nothing here
 * goes through `ctx.sessions`: the recovery appends to the session the failing
 * request already belongs to.
 */
export const inject: readonly string[] = ['tokenMeter']

/** The prefix of every diagnostic this plugin logs. */
const LOG_PREFIX = 'overflow-recovery:'

/**
 * Recoveries performed since the session last answered a request.
 *
 * Reset on a committed `assistant/message`, exactly as the shipped compaction
 * engine resets its own overflow budget: the bound means "attempts to un-wedge
 * this incident", not "attempts over the lifetime of this session", because a
 * long-lived session that overflows twice months apart is two incidents.
 */
const recoveries = new WeakMap<Session, number>()

/**
 * Install the plugin.
 * @param ctx - the plugin context; both listeners are disposed with it.
 * @param config - the configuration as mounted, possibly empty. Defaults are
 *   applied here rather than in an exported `Config` object, because a plain
 *   object under that name is read as a schema by the Loader and makes the
 *   plugin unmountable.
 * @throws {TypeError} when `mode` names no mode this plugin implements.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return

  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') recoveries.delete(session)
  })

  ctx.on('agent/request-error', async ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
    // The chain decides first: a summarizer that can fit the window, a provider
    // retry, and another recovery all outrank a deterministic drop of history.
    const downstream = await settleDownstream(next)
    if (downstream.type === 'decision' && downstream.decision !== undefined) return downstream.decision
    if (downstream.type === 'error') {
      // A downed listener is not a reason to replay the overflow unchanged: the
      // deterministic drop is exactly what remains when the smarter recovery is
      // unavailable. The original overflow still surfaces if this drop is refused.
      ctx.logger.warn(`${LOG_PREFIX} ignoring a downstream recovery failure: ${String(downstream.error)}`)
    }
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return undefined

    const session = agent.session
    const used = recoveries.get(session) ?? 0
    if (used >= settings.maxRecoveries) {
      ctx.logger.warn(
        `${LOG_PREFIX} leaving this overflow alone: ${used} recoveries already performed on `
        + `session ${session.id} since it last answered, and the overflowing content is not in `
        + 'droppable surface positions',
      )
      return undefined
    }

    const plan = attempt(ctx, session, settings)
    if (plan === null) return undefined

    const reduction = `${plan.range.shadowedSeqs.length} surface message(s) worth `
      + `~${plan.range.droppedTokens} tokens in session ${session.id} (the notice prices at `
      + `~${plan.replacementTokens})`
    if (settings.mode === 'report') {
      // Nothing is written and nothing is counted: the bound measures recoveries
      // performed, and `report` performs none. The wording says so too — a report
      // line that mentioned a drop would make the mode indistinguishable from an
      // acting one in the log a user reads.
      ctx.logger.warn(
        `${LOG_PREFIX} would drop ${reduction}; this mode writes nothing and the request is left `
        + 'to fail unchanged',
      )
      return undefined
    }

    try {
      commitRecovery(session, plan)
    } catch (error: unknown) {
      ctx.logger.warn(`${LOG_PREFIX} leaving this overflow alone: the session refused the drop: ${String(error)}`)
      return undefined
    }
    recoveries.set(session, used + 1)
    ctx.logger.warn(
      `${LOG_PREFIX} dropped ${reduction}; the shadowed events remain in the log and this request `
      + 'is retried against the reduced surface',
    )
    return { kind: 'retry' }
  })
}

/**
 * Price one drop, turning any refusal into a log line.
 *
 * A pricing that threw would replace the overflow the user can read with a plugin
 * stack trace, and the turn fails either way — so the refusal is reported and the
 * caller leaves the request error as it found it. Nothing is written here: `report`
 * mode calls exactly this and stops.
 * @param ctx - the plugin context, for logging and the meter.
 * @param session - the session whose surface would be reduced.
 * @param settings - retention bounds and mode.
 * @returns the plan, or `null` when there is nothing to log.
 */
function attempt(
  ctx: Context,
  session: Session,
  settings: Settings,
): RecoveryPlan | null {
  try {
    const plan = planRecovery(session, ctx.tokenMeter, settings)
    if (plan === null) {
      ctx.logger.warn(
        `${LOG_PREFIX} leaving this overflow alone: the surface holds nothing droppable between `
        + `the system head and the retained tail of ~${settings.retainTokens} estimated tokens`,
      )
    }
    return plan
  } catch (error: unknown) {
    ctx.logger.warn(`${LOG_PREFIX} leaving this overflow alone: the session refused the drop: ${String(error)}`)
    return null
  }
}

/**
 * Await the rest of the waterfall without letting it fail this listener.
 *
 * The shipped retry listener contains downstream failures the same way
 * (`@deepseek-ai/dsh-llm-retry`), because a waterfall has exactly one place to
 * put an exception and it is not the one that can still recover the turn.
 * @param next - the rest of the chain.
 * @returns either its decision or the error it threw.
 */
async function settleDownstream(
  next: () => Promise<RequestErrorAction>,
): Promise<{ type: 'decision'; decision: RequestErrorAction } | { type: 'error'; error: unknown }> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error: unknown) {
    return { type: 'error', error }
  }
}

export default { name, inject, apply }
