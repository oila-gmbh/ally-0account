import { readdir } from 'node:fs/promises'

import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'

async function testFiles(): Promise<URL[]> {
  const testsDir = new URL('../tests/', import.meta.url)
  const entries = await readdir(testsDir)
  return entries
    .filter((entry) => entry.endsWith('.spec.ts'))
    .map((entry) => new URL(entry, testsDir))
}

processCLIArgs(process.argv.slice(2))
configure({
  files: testFiles,
  plugins: [assert()],
})

await run()
