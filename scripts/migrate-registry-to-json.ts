#!/usr/bin/env bun
/**
 * One-shot migration script: converts registry .md files (with YAML frontmatter)
 * to plain .json files, discarding the markdown body.
 *
 * Usage (from repo root):
 *   bun run scripts/migrate-registry-to-json.ts
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import consola from 'consola'

const REGISTRY_DIR = join(import.meta.dirname, '../apps/registry/content/registry')

/**
 * Extracts the YAML content between the first pair of `---` delimiters.
 * Throws if no frontmatter block is found.
 */
export function extractFrontmatter(content: string): string {
  const lines = content.split('\n')
  if (lines[0].trim() !== '---') {
    throw new Error('No frontmatter found: file does not start with ---')
  }
  const closingIndex = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (closingIndex === -1) {
    throw new Error('No frontmatter found: missing closing ---')
  }
  return lines.slice(1, closingIndex).join('\n')
}

/**
 * Parses a YAML string into a JavaScript object using the `yaml` package.
 */
export function parseFrontmatter(yaml: string): Record<string, unknown> {
  return parse(yaml) as Record<string, unknown>
}

function collectMdFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectMdFiles(fullPath))
    }
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath)
    }
  }
  return files
}

function migrate(): void {
  const mdFiles = collectMdFiles(REGISTRY_DIR)
  let count = 0

  for (const mdPath of mdFiles) {
    const content = readFileSync(mdPath, 'utf-8')
    const yaml = extractFrontmatter(content)
    const data = parseFrontmatter(yaml)
    const jsonPath = mdPath.replace(/\.md$/, '.json')
    writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    rmSync(mdPath)
    count++
  }

  consola.success(`Migrated ${count} registry entries from .md to .json`)
}

// Run when invoked directly (not when imported by tests)
if (import.meta.main) {
  migrate()
}
