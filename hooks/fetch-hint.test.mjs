import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildHint } from './fetch-hint.mjs'

const KNOWN = {
  'emulate.dev': 'github:vercel-labs/emulate',
  'astro.build': 'npm:astro',
}

test('github repo root suggests ask docs and ask src', () => {
  const hint = buildHint('https://github.com/vercel-labs/emulate', KNOWN)
  assert.match(hint, /ask docs github:vercel-labs\/emulate/)
  assert.match(hint, /ask src github:vercel-labs\/emulate/)
})

test('github blob URL suggests ask src with ref and file path', () => {
  const hint = buildHint('https://github.com/TanStack/query/blob/v5.62.0/packages/query-core/src/query.ts', KNOWN)
  assert.match(hint, /ask src github:TanStack\/query --ref v5\.62\.0/)
  assert.match(hint, /<checkoutDir>\/packages\/query-core\/src\/query\.ts/)
})

test('github tree URL suggests ask src with ref', () => {
  const hint = buildHint('https://github.com/vercel/next.js/tree/canary/docs', KNOWN)
  assert.match(hint, /ask src github:vercel\/next\.js --ref canary/)
})

test('github code search suggests ask search with the query', () => {
  const hint = buildHint('https://github.com/hono/hono/search?q=middleware', KNOWN)
  assert.match(hint, /ask search github:hono\/hono "middleware"/)
})

test('raw.githubusercontent.com suggests ask src, including refs/heads form', () => {
  const plain = buildHint('https://raw.githubusercontent.com/colinhacks/zod/v3.24.1/README.md', KNOWN)
  assert.match(plain, /ask src github:colinhacks\/zod --ref v3\.24\.1/)
  const refsForm = buildHint('https://raw.githubusercontent.com/colinhacks/zod/refs/heads/main/README.md', KNOWN)
  assert.match(refsForm, /--ref main/)
  assert.match(refsForm, /<checkoutDir>\/README\.md/)
})

test('known docs host maps to its spec, including docs. subdomains', () => {
  assert.match(buildHint('https://emulate.dev/docs', KNOWN), /ask docs github:vercel-labs\/emulate/)
  assert.match(buildHint('https://docs.astro.build/en/getting-started/', KNOWN), /ask docs npm:astro/)
})

test('dynamic github routes and non-repo paths stay silent', () => {
  assert.equal(buildHint('https://github.com/vercel/next.js/issues/123', KNOWN), null)
  assert.equal(buildHint('https://github.com/vercel/next.js/pull/456', KNOWN), null)
  assert.equal(buildHint('https://github.com/vercel/next.js/releases', KNOWN), null)
  assert.equal(buildHint('https://github.com/trending', KNOWN), null)
  assert.equal(buildHint('https://github.com/features/copilot', KNOWN), null)
})

test('unknown hosts and malformed URLs stay silent', () => {
  assert.equal(buildHint('https://example.com/docs', KNOWN), null)
  assert.equal(buildHint('not a url', KNOWN), null)
  assert.equal(buildHint('ftp://github.com/a/b', KNOWN), null)
})

test('hint includes the command cheatsheet', () => {
  const hint = buildHint('https://github.com/vercel-labs/emulate', KNOWN)
  assert.match(hint, /ask search <spec> "<query>"/)
  assert.match(hint, /ask add <spec>/)
})
