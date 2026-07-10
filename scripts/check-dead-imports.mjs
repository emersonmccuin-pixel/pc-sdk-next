// CI gate: fail if any source file imports the architecture we deleted.
// Banned: PTY runtime, agent-host, workflow engine, supervisor, work items, xterm/node-pty,
// and the dead runtime-* wire modules from @pc/contracts.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SCAN_DIRS = ['apps', 'packages']
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo'])

const BANNED = [
  { re: /@pc\/runtime\b/, why: 'PTY runtime is deleted' },
  { re: /@pc\/agent-host\b/, why: 'agent-host is deleted' },
  { re: /@pc\/workflows\b/, why: 'workflow engine is deleted' },
  { re: /@pc\/supervisor\b/, why: 'supervisor is deleted (boot recovery replaces it)' },
  { re: /node-pty/, why: 'no PTY anywhere' },
  { re: /(@xterm\/|['"]xterm)/, why: 'no terminal UI' },
  { re: /work[-_]?items?\b/i, why: 'work items live in AInativePM, not here' },
  { re: /runtime-(events|commands|wire)/, why: 'dead runtime-* wire modules from @pc/contracts' },
]

// Only import/require/export-from lines — a comment mentioning "workflow" is fine.
const IMPORT_LINE = /^\s*(import|export)\b.*from\s+['"][^'"]+['"]|require\s*\(\s*['"][^'"]+['"]\s*\)/

const violations = []

function scan(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) { scan(full); continue }
    if (!EXTS.has(name.slice(name.lastIndexOf('.')))) continue
    const lines = readFileSync(full, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!IMPORT_LINE.test(line)) return
      for (const { re, why } of BANNED) {
        if (re.test(line)) violations.push(`${relative(ROOT, full)}:${i + 1} — ${why}\n    ${line.trim()}`)
      }
    })
  }
}

for (const d of SCAN_DIRS) scan(join(ROOT, d))

if (violations.length) {
  console.error(`Dead-import check FAILED (${violations.length}):\n`)
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log('Dead-import check passed.')
