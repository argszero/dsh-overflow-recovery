/**
 * Configuration for the deterministic overflow-recovery drop.
 *
 * Defaults live here rather than in an exported `Config` object: the Loader
 * reads a plain object under that name as a standard-schema validator and the
 * plugin becomes unmountable, so a function plugin validates its own config.
 *
 * @module @argszero/dsh-overflow-recovery/config
 */

/** The modes this plugin implements, in the order they are documented. */
export const MODES = ['recover', 'report', 'off'] as const

/**
 * What the plugin does when a request fails with a context-window overflow and
 * nothing else in `agent/request-error` claimed the retry.
 *
 * - `recover` (default) — drop the oldest droppable region of the model-visible
 *   surface in one durable replacement and let the loop retry the request.
 * - `report` — write nothing and log the reduction `recover` would have made,
 *   for a deployment that wants to see the size of the drop before allowing it.
 *   The turn still fails in this mode, because nothing in the request changed.
 * - `off` — install no listener at all.
 */
export type Mode = typeof MODES[number]

/** The configuration as mounted. */
export interface Config {
  /** Which of {@link MODES} to run. Defaults to `recover`. */
  readonly mode?: Mode
  /**
   * Estimated tokens to keep verbatim at the newest end of the surface.
   * The drop never removes a node inside this retained tail. Defaults to
   * {@link DEFAULT_RETAIN_TOKENS}.
   */
  readonly retainTokens?: number
  /**
   * Never retain fewer than this many newest surface nodes, so a single
   * oversized node cannot pull the retained tail back past the current
   * exchange. Defaults to {@link DEFAULT_RETAIN_MIN_NODES}.
   */
  readonly retainMinNodes?: number
  /**
   * Most recoveries this plugin performs on one live session before it stops
   * claiming the retry. Bounds the cost of a route whose other content (system
   * prompt, tool definitions) cannot be made to fit. Defaults to
   * {@link DEFAULT_MAX_RECOVERIES}.
   */
  readonly maxRecoveries?: number
}

/** Retained-tail budget in estimated tokens. */
export const DEFAULT_RETAIN_TOKENS = 24_000

/** Minimum number of newest surface nodes retained verbatim. */
export const DEFAULT_RETAIN_MIN_NODES = 4

/** Recoveries allowed per live session. */
export const DEFAULT_MAX_RECOVERIES = 3

/** The configuration after validation, with every default applied. */
export interface Settings {
  readonly mode: Mode
  readonly retainTokens: number
  readonly retainMinNodes: number
  readonly maxRecoveries: number
}

/**
 * Validate the mounted configuration.
 *
 * An unrecognised `mode` is refused rather than quietly replaced, because a
 * deployment that misspells a mode must not silently get a different one. The
 * numeric knobs are clamped instead: a nonsensical bound is a typo with an
 * obviously intended reading, and refusing it would turn a recoverable
 * deployment into a plugin that never loads.
 * @param config - the configuration as mounted, possibly empty.
 * @returns the resolved settings.
 * @throws {TypeError} when `mode` names no mode this plugin implements.
 */
export function normalizeConfig(config: Config = {}): Settings {
  const requested: string = config.mode ?? 'recover'
  const mode = MODES.find(candidate => candidate === requested)
  if (mode === undefined) {
    throw new TypeError(
      `overflow-recovery: mode must be one of ${MODES.join(', ')} — got ${JSON.stringify(config.mode)}`,
    )
  }
  return {
    mode,
    retainTokens: bounded(config.retainTokens, DEFAULT_RETAIN_TOKENS, 0),
    retainMinNodes: bounded(config.retainMinNodes, DEFAULT_RETAIN_MIN_NODES, 0),
    maxRecoveries: bounded(config.maxRecoveries, DEFAULT_MAX_RECOVERIES, 0),
  }
}

/** One finite, integral, non-negative knob, or its default. */
function bounded(value: number | undefined, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return fallback
  return Math.floor(value)
}
