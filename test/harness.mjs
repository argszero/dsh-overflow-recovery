/**
 * The harness: a REAL cordis context carrying the REAL services this plugin
 * depends on (`LlmRuntime`, `SessionProjectionRegistry`, `TokenMeter`), a REAL
 * `@deepseek-ai/dsh-session` `Session` built with the real append API, and the
 * REAL `agent/request-error` waterfall dispatched through `agentEvents(ctx, agent)`
 * — the same fused dispatcher the agent loop calls.
 *
 * Three things are deliberately not simulated:
 *
 * - **The dispatcher.** `recover()` goes through `agentEvents`, so scope filtering,
 *   `{ prepend: true }` ordering and the waterfall's value passing are the shipped
 *   ones. An arm that passes here passes for the same reason the loop would.
 * - **The surface fold.** The session is a shipped `Session`, so every append the
 *   plugin makes is validated by the shipped `surface.ts` predicates — a
 *   replacement that omitted a shadowed node, split a tool pair or tried to
 *   rewrite the system head throws here exactly as it would in production.
 * - **The prices.** `TokenMeter` is the shipped service, so "the replacement is
 *   smaller than the span" is decided by the same estimator the engine uses.
 *
 * One thing IS a stand-in, and it is named here rather than left implicit: the
 * terminal `next` below is the loop's own (`() => Promise.resolve(undefined)`), but
 * a *downstream listener* in these arms is written by hand rather than being the
 * real compaction engine — the engine needs a routed model and a summarizer, and
 * what each arm measures is only the value the chain returns. `downstream: 'claim'`
 * and `downstream: 'throw'` are the two shapes that matter to the decision this
 * plugin makes; `'passes'` is the shape of an engine that declined.
 *
 * `world({ mounted: false })` is the control arm for every "the plugin recovered
 * the turn" claim: the same context, the same session, the same failure, with
 * nothing mounted.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, LlmRuntime, createMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import plugin, * as namespace from '../lib/index.js'

/** The module namespace, for the arm that asserts both export forms mount. */
export { namespace }

/** The model every fixture routes through. */
export const MODEL = 'harness-model'

/**
 * The attachment reference the image-bearing fixture carries.
 *
 * The meter never opens the bytes: it prices an occurrence through the route's
 * `priceImages`, so a well-formed reference is all this has to be.
 */
const HARNESS_IMAGE = {
  attachmentId: 'harness-image',
  mediaType: 'image/png',
  bytes: 1_024,
  width: 64,
  height: 64,
}

/** A fresh, never-aborted turn signal. */
export function signal() {
  return new AbortController().signal
}

/**
 * Collect every structured log record this process publishes.
 *
 * `levels` is not decoration: an exporter that declares none falls back to
 * `LoggerLevel.INFO` as its threshold, and `warn` is *above* INFO, so a capture
 * registered without it silently drops exactly the records these arms assert on.
 */
export function captureLogs(ctx) {
  const records = []
  ctx.logger.exporter({ colors: false, levels: { default: 3 }, export: message => records.push(message) })
  return {
    records,
    /** Every captured record of one severity whose format string contains `needle`. */
    matching(needle, type = 'warn') {
      return records.filter(record => record.type === type && String(record.args[0]).includes(needle))
    },
  }
}

/**
 * What the harness route charges for one image occurrence.
 *
 * Deliberately unrelated to anything the fixed heuristic would say: the meter
 * prices an image-bearing node at the route's declared visual price and keeps
 * the heuristic price beside it, and the two are equal for every text-only
 * message. Only a fixture with an image can tell the two fields apart, which is
 * what makes the arms about which field feeds which quantity observable at all.
 */
export const IMAGE_VISUAL_TOKENS = 1_234

/** An adapter that only has to answer `resolveModel`, so the meter prices the fixture. */
class HarnessAdapter extends LlmAdapter {
  #contextWindow

  constructor(contextWindow = 1_000_000) {
    super()
    this.#contextWindow = contextWindow
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.#contextWindow },
    })
  }

  // Declaring this is what makes `TokenSurfaceNode.tokens` differ from
  // `heuristicTokens` on an image-bearing node; without it the meter falls back to
  // the heuristic for every node and the two fields are indistinguishable.
  imageRequestPricing() {
    return {
      priceImages: images => images.map(() => ({
        visualTokens: IMAGE_VISUAL_TOKENS,
        text: 'an image',
      })),
    }
  }

  // eslint-disable-next-line require-yield -- the terminal frame is the whole stream.
  async * stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Build one world.
 * @param world.mounted - `false` mounts nothing, which is the control arm.
 * @param world.config - the plugin configuration to mount with.
 * @param world.form - which export to mount: the `default` (what a Loader entry
 *   resolves) or the module `namespace`.
 * @param world.downstream - `null` adds no other listener; `'claim'` adds one that
 *   answers `{ kind: 'retry' }`; `'passes'` adds one that calls `next()` and
 *   returns its value; `'throws'` adds one that throws.
 * @param world.mountFirst - `true` registers the downstream listener BEFORE the
 *   plugin, so the two registrations arrive in the other order; both must work.
 * @returns the context, the log capture, and the dispatch entry.
 */
export async function world({ mounted = true, config = {}, form = 'default', downstream = null, mountFirst = false } = {}) {
  const ctx = new Context()
  const logs = captureLogs(ctx)
  void new LlmRuntime(ctx)
  // The registry is a required injection of TokenMeter (its three projection
  // units register in the constructor); mount it synchronously.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const store = new SessionStore(ctx)
  ctx.llm.registerAdapter([MODEL], new HarnessAdapter())

  if (mountFirst && downstream !== null) mountDownstream(ctx, downstream)
  if (mounted) await ctx.plugin(form === 'namespace' ? namespace : plugin, config)
  if (!mountFirst && downstream !== null) mountDownstream(ctx, downstream)

  const instance = {
    ctx,
    logs,
    /** The store a fixture is entered into, which is what publishes `session/event`. */
    store,
    /** Dispatch one `agent/request-error`, exactly as the loop does. */
    recover: (agent, failure, options = {}) => recover(ctx, agent, failure, options),
    /**
     * Build a fixture AND adopt it into this world's store.
     *
     * Adoption is not decoration. A session created by `Session.create` is attached
     * to no context and therefore publishes no `session/event` at all, so every arm
     * about what the plugin hears from the session would be an arm about nothing.
     * `enter()` is the shipped adoption path, so the reset this plugin performs on a
     * committed `assistant/message` is measured against the same publication the
     * runtime performs.
     */
    conversation: options => enter(instance, conversation(options)),
    /** As above, for the tool-call fixture. */
    toolConversation: options => enter(instance, toolConversation(options)),
  }
  return instance
}

/**
 * Enter a fixture into one world's store.
 * @param instance - the object `world()` returned.
 * @param session - the fixture to adopt.
 * @returns the session, for chaining into a fixture builder.
 */
function enter(instance, session) {
  instance.store.enter(session)
  return session
}

/** Register the downstream listener one arm asked for. */
function mountDownstream(ctx, shape) {
  if (shape === 'claim') {
    // The claim listener is registered LAST so that, in waterfall order, it runs
    // after the plugin's own listener has passed the chain along — the shape of
    // "somebody downstream owns this retry".
    ctx.on('agent/request-error', () => Promise.resolve({ kind: 'retry' }))
    return
  }
  if (shape === 'passes') {
    ctx.on('agent/request-error', (_payload, next) => next())
    return
  }
  if (shape === 'throws') {
    ctx.on('agent/request-error', () => {
      throw new Error('downstream recovery exploded')
    })
    return
  }
  throw new Error(`harness: unknown downstream shape ${String(shape)}`)
}

/**
 * Dispatch one `agent/request-error`, exactly as the loop does.
 *
 * The terminal is the loop's own: `agent-loop/src/agent.ts` passes
 * `() => Promise.resolve(undefined)`, and the loop retries only when the composed
 * value is `{ kind: 'retry' }`.
 * @param ctx - the world's context.
 * @param agent - the agent whose request failed.
 * @param failure - the serializable failure the adapter produced.
 * @param options.provider - the provider name.
 * @param options.signal - the turn signal; defaults to a fresh one.
 * @returns the action the waterfall composed.
 */
export async function recover(ctx, agent, failure, { provider = 'harness', signal: turnSignal = signal() } = {}) {
  const turn = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 1
  return await agentEvents(ctx, agent).waterfall(
    'agent/request-error',
    { turn, step: 1, provider, failure, retryPolicy: undefined, signal: turnSignal },
    () => Promise.resolve(undefined),
  )
}

/** The `Agent` shell a failure is dispatched against; only `session` and `options` are read. */
export function agentFor(session) {
  return { session, options: {}, status: 'idle' }
}

/** One `request/header` for the fixture's route, so the meter has an envelope to price under. */
function appendHeader(session) {
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
}

/**
 * A closed conversation: `turns` two-message turns of `words` words each, then one
 * open turn.
 *
 * A `system` argument puts a `system/message` at surface node 0 — the node the
 * drop must never touch. `imageTurns` puts one image occurrence in each named
 * turn's user message, which is the only way this fixture can tell the meter's
 * route price apart from its fixed heuristic price — an image-bearing node is
 * priced at the route's declared visual price, and every text-only node is priced
 * at the heuristic.
 * @param options.turns - closed turns to append.
 * @param options.words - how many words each message carries (drives the price).
 * @param options.system - system prompt text, for a real surface head.
 * @param options.imageTurns - turns whose user message also carries an image.
 * @returns the session.
 */
export function conversation({ turns = 6, words = 400, system = 'You are a harness fixture.', imageTurns = [] } = {}) {
  const session = Session.create(SessionId(`overflow-recovery-${turns}-${words}-${imageTurns.join('.')}`))
  const body = Array.from({ length: words }, (_, index) => `word${index}`).join(' ')
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1) {
      session.append('system/message', {
        turn,
        step: 1,
        message: createSystemMessage(system),
      }, { surfaceOp: 'append' })
    }
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: `user ${turn} ${body}` },
        ...imageTurns.includes(turn) ? [{ type: 'image', attachment: HARNESS_IMAGE }] : [],
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) appendHeader(session)
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant ${turn} ${body}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/**
 * A closed conversation whose assistant messages call a tool the next message
 * answers — the shape a cut must not split.
 * @param options.turns - how many complete call/result pairs to append.
 * @returns the session.
 */
export function toolConversation({ turns = 6 } = {}) {
  const session = Session.create(SessionId(`overflow-recovery-tools-${turns}`))
  const body = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ')
  for (let turn = 1; turn <= turns; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    if (turn === 1) {
      session.append('system/message', {
        turn,
        step: 1,
        message: createSystemMessage('You are a harness fixture.'),
      }, { surfaceOp: 'append' })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${turn} ${body}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) appendHeader(session)
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `calling tool ${turn} ${body}` },
          { type: 'tool-call', id: callId, name: 'harness-tool', arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'harness-tool', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `result ${turn} ${body}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/**
 * One further USER message with no answer, for arms that must keep an incident open.
 *
 * `appendExchange` commits an assistant message, which is the session answering
 * again and therefore ends the incident a recovery bound counts. An arm measuring
 * the bound itself must grow the surface *without* answering it — this is that
 * shape, and the difference is the whole point of the two arms that use them.
 * @param session - the session to grow.
 * @param turn - the turn number to open.
 * @param options.words - how many words the message carries (drives the price).
 * @returns the session, for chaining.
 */
export function appendPrompt(session, turn, { words = 400 } = {}) {
  const body = Array.from({ length: words }, (_, index) => `word${index}`).join(' ')
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `user ${turn} ${body}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session
}

/** One further completed exchange, for arms that outlive a recovery. */
export function appendExchange(session, turn) {
  const body = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ')
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `user ${turn} ${body}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `assistant ${turn} ${body}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** The failure the loop would build from a provider 400. */
export function overflowFailure(message = 'request too large for model context') {
  return { message, code: 'CONTEXT_WINDOW_EXCEEDED' }
}

/** A failure with some other code, which this plugin must never act on. */
export function otherFailure(message = 'rate limited', code = 'RATE_LIMITED') {
  return { message, code }
}

/** Every surface node seq, in model-visible order. */
export function surfaceSeqs(session) {
  return [...session.surface.nodes]
}

/** Every durable event of one type, in log order. */
export function eventsOfType(session, type) {
  return session.snapshotEvents().filter(event => event.type === type)
}

/**
 * The message the surface currently shows at one position.
 * @param session - the session to read.
 * @param index - the surface position.
 * @returns the derived message, or `undefined` when the position holds none.
 */
export function surfaceMessageAt(session, index) {
  const seq = session.surface.nodes[index]
  if (seq === undefined) return undefined
  // oxlint-disable-next-line typescript/no-deprecated -- surface positions are current log indices.
  const event = session.eventAt(seq)
  return event === undefined ? undefined : session.deriveEventMessage(event) ?? undefined
}

/**
 * Tool-call/result balance of the whole current surface.
 *
 * The drop is safe exactly when this returns zero: an unanswered call left on the
 * surface is the orphan-`tool/call` shape that wedges a session permanently.
 * @param session - the session to read.
 * @returns how many tool calls the surface leaves unanswered.
 */
export function unansweredToolCalls(session) {
  let open = 0
  for (const seq of session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- surface positions are current log indices.
    const event = session.eventAt(seq)
    const message = event === undefined ? undefined : session.deriveEventMessage(event)
    if (message === undefined || message === null) continue
    if (message.role === 'assistant') {
      open += message.content.filter(block => block.type === 'tool-call').length
    } else if (message.role === 'tool') {
      open -= 1
    }
  }
  return open
}

/** The joined text of one surface message. */
export function textOf(message) {
  if (message === undefined) return ''
  return message.content.map(block => block.text ?? '').join('')
}
