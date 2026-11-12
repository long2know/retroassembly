import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const directory = path.resolve('tests/unit')
const requested = process.argv.slice(2)
const filenames = await fs.readdir(directory)
const sources = requested.length
  ? requested.map((filename) => path.resolve(filename))
  : filenames.filter((filename) => filename.endsWith('.test.ts')).map((filename) => path.join(directory, filename))
for (const filename of sources) {
  assert.ok(filename.startsWith(`${directory}${path.sep}`), 'Unit tests must be inside tests/unit')
}
assert.ok(sources.length, 'No unit tests selected')
const outputDirectory = path.resolve('node_modules/.cache/retroassembly-unit-tests')
const outputs = sources.map((filename) => path.join(outputDirectory, `${path.basename(filename, '.ts')}.mjs`))
await fs.mkdir(outputDirectory, { recursive: true })

try {
  await build({
    absWorkingDir: root,
    banner: {
      js: "import { createRequire as createUnitRequire } from 'node:module'; var require = createUnitRequire(import.meta.url);",
    },
    bundle: true,
    entryPoints: sources,
    external: ['better-sqlite3'],
    format: 'esm',
    logLevel: 'warning',
    outdir: outputDirectory,
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    sourcemap: 'inline',
    target: 'node26.5',
  })
  const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' })
  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
} finally {
  for (const filename of outputs) {
    await fs.rm(filename, { force: true })
  }
}
