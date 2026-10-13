/**
 * Cross-line calibration: run the suite once per released harness line, each in
 * its own scratch tree with every harness package pinned to that line.
 *
 * The supported-lines list in the README is the CLAIM; this script is where the
 * claim is measured. A line that fails here must be dropped from that list and
 * from the peer ranges — a plugin that names a line it does not work on is a
 * plugin whose install breaks for the consumer who picks it.
 *
 * The scratch tree is a copy of `src/`, `test/` and `tsconfig.json` with only
 * `devDependencies` rewritten, so the suite that runs is the suite that ships.
 *
 * @module scripts/probe-lines
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The lines the plugin claims, each with the Cordis series its packages build on. */
const LINES = {
  '0.1.7-rc.2': '4.0.4',
  '0.2.0-rc.2': '4.0.4',
  '0.2.1-alpha.2': '~4.0.5-alpha.1',
}

/** Packages that move with the harness line: the peers, plus the harness-only dev mount. */
const LINE_PACKAGES = [
  ...Object.keys(manifest.peerDependencies).filter(name => name !== '@deepseek-ai/cordis'),
  // The suite mounts the projection registry directly, so it is a dev dependency
  // that moves with the line exactly as the peers do — leaving it at the newest
  // alpha beside older peers would measure a tree no consumer can install.
  '@deepseek-ai/dsh-session-projection',
]

const SCRATCH = join(ROOT, 'tmp', 'lines')
rmSync(SCRATCH, { recursive: true, force: true })

let failed = 0
for (const [line, cordis] of Object.entries(LINES)) {
  const dir = join(SCRATCH, line)
  mkdirSync(dir, { recursive: true })
  for (const entry of ['src', 'test', 'scripts', 'tsconfig.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  }
  const devDependencies = { ...manifest.devDependencies, '@deepseek-ai/cordis': cordis }
  for (const name of LINE_PACKAGES) devDependencies[name] = line
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ ...manifest, devDependencies }, null, 2)}\n`)

  process.stdout.write(`\n===== ${line} (cordis ${cordis}) =====\n`)
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'pipe' })
    execFileSync(process.execPath, [join(dir, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: dir, stdio: 'pipe' })
    const output = execFileSync(process.execPath, ['--test', 'test/*.spec.mjs'], { cwd: dir, encoding: 'utf8' })
    const summary = output.split('\n').filter(l => /^ℹ (tests|pass|fail)/.test(l)).join(' | ')
    console.log(`PASS ${line}: ${summary}`)
    if (!/fail 0/.test(output)) failed += 1
  } catch (error) {
    failed += 1
    console.log(`FAIL ${line}:`)
    console.log(String(error.stdout ?? '').split('\n').slice(-40).join('\n'))
    console.log(String(error.stderr ?? '').split('\n').slice(-10).join('\n'))
  }
}

console.log(`\nLINES FAILED: ${failed === 0 ? 'none' : String(failed)}`)
process.exit(failed === 0 ? 0 : 1)
