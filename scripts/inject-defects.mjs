/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is SILENT —
 * it proves nothing about the test that was supposed to hold the line.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with tsc
 * first; a mutation that fails to type-check proves nothing either, and is
 * reported separately as UNBUILDABLE. The source is restored **and rebuilt**
 * whatever happened: an injector that can leave a mutation (or a stale `lib/`) in
 * the tree would be worse than no injector, and a stale `lib/` is exactly how an
 * arm goes SILENT.
 *
 * Every mutation here is a defect this plugin could plausibly ship — a predicate
 * loosened, a gate inverted, a price read from the wrong field, a bookkeeping map
 * left behind, a refusal allowed to escape. None is engineered to be caught: each
 * names the shape of mistake the arm exists for.
 *
 * The whole suite runs for every arm (it takes a fraction of a second), so an arm
 * may be caught by more than one test; what is asserted is that SOMETHING goes
 * red, which is the only thing a mutation can prove on its own.
 *
 * Run from the plugin root: `npm run test:inject`.
 *
 * The control arm is the unmutated suite, run first: every mutant is compared
 * against a suite that is known green, so a manifest-wide failure (a broken
 * dependency, a missing build) cannot be mistaken for a caught defect.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SUITE = '*.spec.mjs'

const MUTATIONS = [
  {
    name: 'the system head is allowed inside the dropped range, so the drop rewrites the system prompt',
    file: 'src/select.ts',
    edits: [['  const firstIdx = 1', '  const firstIdx = 0']],
  },
  {
    name: 'the balanced-cut check is dropped, so the drop may split a tool-call from its result',
    file: 'src/select.ts',
    edits: [[
      '  while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(session, seqAt(nodes, keepFromIdx))) {',
      '  while (false) {',
    ]],
  },
  {
    name: 'the retained-tail price is never accumulated, so no surface is ever considered droppable',
    file: 'src/select.ts',
    edits: [['    accumulated += nodes[index]!.tokens', '    accumulated += 0']],
  },
  {
    name: 'the retention budget is walked with the fixed heuristic instead of the route price',
    file: 'src/select.ts',
    edits: [['    accumulated += nodes[index]!.tokens', '    accumulated += nodes[index]!.heuristicTokens']],
  },
  {
    name: 'the dropped span is priced at the fixed heuristic instead of the route price',
    file: 'src/select.ts',
    edits: [['    droppedTokens += node.tokens', '    droppedTokens += node.heuristicTokens']],
  },
  {
    name: 'the shadow claim is priced at the route price instead of the fixed heuristic',
    file: 'src/select.ts',
    edits: [['    shadowedTokenCount += node.heuristicTokens', '    shadowedTokenCount += node.tokens']],
  },
  {
    name: 'the range start is read from position 0, so the replacement does not match what it shadows',
    file: 'src/select.ts',
    edits: [['    start: seqAt(nodes, firstIdx),', '    start: seqAt(nodes, 0),']],
  },
  {
    name: 'the shrink check is inverted, so a drop that would not be smaller is made anyway',
    file: 'src/recover.ts',
    edits: [['  if (replacementTokens >= range.droppedTokens) return null', '  if (range.droppedTokens >= replacementTokens) return null']],
  },
  {
    name: 'only the shadow price is cited, so the session cannot verify the range it is replacing',
    file: 'src/recover.ts',
    edits: [['    sourceEventSeqs: [prune.seq, ...range.shadowedSeqs],', '    sourceEventSeqs: [prune.seq],']],
  },
  {
    name: 'the replacement appends instead of replacing, so the dropped messages stay on the surface',
    file: 'src/recover.ts',
    edits: [['    surfaceOp: { op: \'replace\', startSeq: range.start, endSeq: range.end },', '    surfaceOp: \'append\',']],
  },
  {
    name: 'the numeric knobs are not sanity-checked, so NaN silently reaches the meter bounds',
    file: 'src/config.ts',
    edits: [[
      '  if (typeof value !== \'number\' || !Number.isFinite(value) || value < min) return fallback',
      '  if (typeof value !== \'number\') return fallback',
    ]],
  },
  {
    name: 'an unparseable mode is not refused, so a misspelled mode mounts and quietly gets a different one',
    file: 'src/config.ts',
    edits: [['  const mode = MODES.find(candidate => candidate === requested)', '  const mode = MODES.find(candidate => candidate === candidate)']],
  },
  {
    name: 'report stops being the default, so a deployment that configures nothing writes history away',
    file: 'src/config.ts',
    edits: [["  const requested: string = config.mode ?? 'recover'", "  const requested: string = config.mode ?? 'report'"]],
  },
  {
    name: 'the listener is installed in off mode, so a deployment that asked for nothing gets a rewrite',
    file: 'src/index.ts',
    edits: [["  if (settings.mode === 'off') return", "  if (settings.mode === 'report') return"]],
  },
  {
    name: 'the incident bookkeeping is reset by every event, so the recovery bound never holds',
    file: 'src/index.ts',
    edits: [[
      "    if (event.type === 'assistant/message') recoveries.delete(session)",
      '    recoveries.delete(session)',
    ]],
  },
  {
    name: 'the downstream decision is returned whether or not it decided, so the chain\'s silence becomes final',
    file: 'src/index.ts',
    edits: [[
      '    if (downstream.type === \'decision\' && downstream.decision !== undefined) return downstream.decision',
      '    if (downstream.type === \'decision\') return downstream.decision',
    ]],
  },
  {
    name: 'a downed downstream listener is swallowed without a word, so the operator never learns of it',
    file: 'src/index.ts',
    edits: [[
      '      ctx.logger.warn(`${LOG_PREFIX} ignoring a downstream recovery failure: ${String(downstream.error)}`)',
      '      void downstream.error',
    ]],
  },
  {
    name: 'the abort check is dropped, so a turn the user already cancelled has its history rewritten',
    file: 'src/index.ts',
    edits: [[
      '    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return undefined',
      '    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return undefined',
    ]],
  },
  {
    name: 'the failure code is not checked at all, so every provider failure is answered by dropping history',
    file: 'src/index.ts',
    edits: [[
      "    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return undefined",
      "    if (failure.code !== '__never__' || signal.aborted) return undefined",
    ]],
  },
  {
    name: 'the performed-recovery count starts at one, so the very first overflow is refused',
    file: 'src/index.ts',
    edits: [['    const used = recoveries.get(session) ?? 0', '    const used = recoveries.get(session) ?? 1']],
  },
  {
    name: 'the bound is off by one, so one more recovery than configured is performed',
    file: 'src/index.ts',
    edits: [['    if (used >= settings.maxRecoveries) {', '    if (used > settings.maxRecoveries) {']],
  },
  {
    name: 'report mode writes after all, so a diagnostic deployment rewrites the history it only meant to price',
    file: 'src/index.ts',
    edits: [[
      "        + 'to fail unchanged',\n      )\n      return undefined",
      "        + 'to fail unchanged',\n      )",
    ]],
  },
  {
    name: 'the session refusal is rethrown, so a refused drop replaces the overflow with a plugin stack trace',
    file: 'src/index.ts',
    edits: [[
      '      return undefined\n    }\n    recoveries.set(session, used + 1)',
      '      throw error\n    }\n    recoveries.set(session, used + 1)',
    ]],
  },
  {
    name: 'the recovery is priced but never counted, so the bound on repeated recovery never engages',
    file: 'src/index.ts',
    edits: [['    recoveries.set(session, used + 1)', '    recoveries.set(session, used)']],
  },
]

/** Rebuild `lib/` from `src/`; true when tsc accepted the tree. */
function build() {
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Run the suite; true when it failed, plus its output. */
function runSuite() {
  try {
    execFileSync(process.execPath, ['--test', `test/${SUITE}`], { cwd: ROOT, stdio: 'pipe' })
    return { failed: false, output: '' }
  } catch (error) {
    return { failed: true, output: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

// The control arm: the unmutated tree. A suite that is red on its own makes every
// CAUGHT below meaningless, so it is asserted rather than assumed.
if (!build()) {
  console.log('CONTROL UNBUILDABLE: src/ does not compile, no arm below proves anything')
  process.exit(1)
}
const control = runSuite()
if (control.failed) {
  console.log('CONTROL RED: the unmutated suite fails, no arm below proves anything')
  console.log(control.output)
  process.exit(1)
}
console.log('CONTROL: the unmutated suite is green')

let silent = 0
let unbuildable = 0
let missing = 0
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of mutation.edits) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) {
    missing += 1
    continue
  }

  writeFileSync(path, mutated)
  let built = false
  let result = { failed: false, output: '' }
  try {
    built = build()
    if (built) result = runSuite()
  } finally {
    // Restore the source and rebuild, whatever happened: leaving either a mutation
    // or a stale `lib/` behind is the failure mode this file exists to avoid.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  const caught = result.failed && /fail [1-9]/.test(result.output)
  if (!caught) silent += 1
  console.log(`${caught ? 'CAUGHT' : 'SILENT'}: ${mutation.name}`)
}
console.log(`SILENT ARMS: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${String(unbuildable)}; ANCHOR MISSING: ${String(missing)}`)
if (silent > 0 || unbuildable > 0 || missing > 0) process.exit(1)
