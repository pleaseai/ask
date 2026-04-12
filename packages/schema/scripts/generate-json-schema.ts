/**
 * Writes `registry-entry.schema.json` to the package root.
 *
 * Run via `bun run generate` (or as part of the build). The output file
 * can be referenced from registry `.json` entries:
 *
 *   { "$schema": "../../packages/schema/registry-entry.schema.json" }
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registryEntryJsonSchema } from '../src/json-schema.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const outPath = join(__dirname, '..', 'registry-entry.schema.json')

writeFileSync(outPath, `${JSON.stringify(registryEntryJsonSchema, null, 2)}\n`, 'utf-8')

console.log(`Wrote ${outPath}`)
