#!/usr/bin/env tsx
/**
 * Eval results analyzer — aggregates pass rates, duration, token usage,
 * and tool call patterns across experiments and evals.
 *
 * Usage:
 *   bun run analyze                  # latest results
 *   bun run analyze --timestamp T    # specific timestamp
 *   bun run analyze --json           # JSON output
 *   bun run analyze --csv            # CSV output
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

// --- Types ---

interface Usage {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

interface ToolCalls {
  file_read: number
  file_write: number
  file_edit: number
  shell: number
  web_fetch: number
  web_search: number
  glob: number
  grep: number
  list_dir: number
  agent_task: number
  unknown: number
}

interface RunResult {
  status: 'passed' | 'failed' | 'error'
  duration: number
  model: string
  usage: Usage
  toolCalls: ToolCalls
  totalToolCalls: number
  totalTurns: number
  errors: string[]
}

interface EvalSummary {
  eval: string
  runs: RunResult[]
  passRate: number
  passCount: number
  totalRuns: number
  meanDuration: number
  totalUsage: Usage
  totalToolCalls: number
  meanTurns: number
}

interface ExperimentSummary {
  experiment: string
  timestamp: string
  evals: EvalSummary[]
  overall: {
    passRate: number
    passCount: number
    totalRuns: number
    meanDuration: number
    totalUsage: Usage
    estimatedCost: number
  }
}

// --- Token extraction from transcript ---

function extractUsage(transcriptPath: string): Usage {
  const totals: Usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
  if (!existsSync(transcriptPath))
    return totals

  const content = readFileSync(transcriptPath, 'utf-8')
  for (const line of content.split('\n')) {
    if (!line.trim() || !line.includes('input_tokens'))
      continue
    try {
      const d = JSON.parse(line)
      const msg = d?.message
      if (msg?.usage) {
        const u = msg.usage
        totals.input += u.input_tokens ?? 0
        totals.output += u.output_tokens ?? 0
        totals.cacheCreation += u.cache_creation_input_tokens ?? 0
        totals.cacheRead += u.cache_read_input_tokens ?? 0
      }
    }
    catch {}
  }
  return totals
}

// --- Parse a single run ---

function parseRun(runDir: string): RunResult | null {
  const resultPath = join(runDir, 'result.json')
  if (!existsSync(resultPath))
    return null

  const data = JSON.parse(readFileSync(resultPath, 'utf-8'))
  const o11y = data.o11y ?? {}
  const tc = o11y.toolCalls ?? {}

  const transcriptRawPath = join(runDir, 'transcript-raw.jsonl')
  const usage = extractUsage(transcriptRawPath)

  return {
    status: data.status ?? 'error',
    duration: data.duration ?? 0,
    model: data.model ?? 'unknown',
    usage,
    toolCalls: {
      file_read: tc.file_read ?? 0,
      file_write: tc.file_write ?? 0,
      file_edit: tc.file_edit ?? 0,
      shell: tc.shell ?? 0,
      web_fetch: tc.web_fetch ?? 0,
      web_search: tc.web_search ?? 0,
      glob: tc.glob ?? 0,
      grep: tc.grep ?? 0,
      list_dir: tc.list_dir ?? 0,
      agent_task: tc.agent_task ?? 0,
      unknown: tc.unknown ?? 0,
    },
    totalToolCalls: o11y.totalToolCalls ?? 0,
    totalTurns: o11y.totalTurns ?? 0,
    errors: o11y.errors ?? [],
  }
}

// --- Parse an eval directory ---

function parseEval(evalDir: string): EvalSummary | null {
  const evalName = evalDir.split('/').pop()!
  const runs: RunResult[] = []

  const entries = readdirSync(evalDir).filter(e => e.startsWith('run-')).sort()
  for (const entry of entries) {
    const runPath = join(evalDir, entry)
    if (!statSync(runPath).isDirectory())
      continue
    const result = parseRun(runPath)
    if (result)
      runs.push(result)
  }

  if (runs.length === 0)
    return null

  const passCount = runs.filter(r => r.status === 'passed').length
  const totalUsage = runs.reduce<Usage>((acc, r) => ({
    input: acc.input + r.usage.input,
    output: acc.output + r.usage.output,
    cacheCreation: acc.cacheCreation + r.usage.cacheCreation,
    cacheRead: acc.cacheRead + r.usage.cacheRead,
  }), { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 })

  return {
    eval: evalName,
    runs,
    passRate: passCount / runs.length,
    passCount,
    totalRuns: runs.length,
    meanDuration: runs.reduce((s, r) => s + r.duration, 0) / runs.length,
    totalUsage,
    totalToolCalls: runs.reduce((s, r) => s + r.totalToolCalls, 0),
    meanTurns: runs.reduce((s, r) => s + r.totalTurns, 0) / runs.length,
  }
}

// --- Estimate cost (Sonnet 4.6 pricing) ---

function estimateCost(usage: Usage): number {
  // Sonnet: $3/M input, $3.75/M cache write, $0.30/M cache read, $15/M output
  return (
    (usage.input * 3 + usage.cacheCreation * 3.75 + usage.cacheRead * 0.30 + usage.output * 15) / 1_000_000
  )
}

// --- Find latest timestamp for an experiment ---

function findTimestamp(expDir: string, targetTimestamp?: string): string | null {
  if (!existsSync(expDir))
    return null
  const timestamps = readdirSync(expDir)
    .filter(e => statSync(join(expDir, e)).isDirectory())
    .sort()

  if (targetTimestamp) {
    return timestamps.find(t => t.startsWith(targetTimestamp)) ?? null
  }
  return timestamps.at(-1) ?? null
}

// --- Parse an experiment ---

function parseExperiment(resultsDir: string, experiment: string, targetTimestamp?: string): ExperimentSummary | null {
  const expDir = join(resultsDir, experiment)
  const timestamp = findTimestamp(expDir, targetTimestamp)
  if (!timestamp)
    return null

  const tsDir = join(expDir, timestamp)
  const evalDirs = readdirSync(tsDir)
    .filter(e => e.startsWith('eval-') && statSync(join(tsDir, e)).isDirectory())
    .sort()

  const evals: EvalSummary[] = []
  for (const evalName of evalDirs) {
    const result = parseEval(join(tsDir, evalName))
    if (result)
      evals.push(result)
  }

  if (evals.length === 0)
    return null

  const totalRuns = evals.reduce((s, e) => s + e.totalRuns, 0)
  const passCount = evals.reduce((s, e) => s + e.passCount, 0)
  const totalUsage = evals.reduce<Usage>((acc, e) => ({
    input: acc.input + e.totalUsage.input,
    output: acc.output + e.totalUsage.output,
    cacheCreation: acc.cacheCreation + e.totalUsage.cacheCreation,
    cacheRead: acc.cacheRead + e.totalUsage.cacheRead,
  }), { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 })

  return {
    experiment,
    timestamp,
    evals,
    overall: {
      passRate: passCount / totalRuns,
      passCount,
      totalRuns,
      meanDuration: evals.reduce((s, e) => s + e.meanDuration, 0) / evals.length,
      totalUsage,
      estimatedCost: estimateCost(totalUsage),
    },
  }
}

// --- Formatters ---

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function num(n: number): string {
  return n.toLocaleString('en-US')
}

function sec(n: number): string {
  return `${n.toFixed(1)}s`
}

function dollar(n: number): string {
  return `$${n.toFixed(4)}`
}

function totalInput(u: Usage): number {
  return u.input + u.cacheCreation + u.cacheRead
}

// --- Table output ---

function printTable(results: ExperimentSummary[]) {
  const experiments = results.map(r => r.experiment)
  const allEvals = [...new Set(results.flatMap(r => r.evals.map(e => e.eval)))].sort()

  // Header
  console.log('\n' + '='.repeat(100))
  console.log('  EVAL RESULTS ANALYSIS')
  console.log('='.repeat(100))

  // Per-eval comparison
  console.log('\n## Pass Rate by Eval')
  console.log('')
  const header = ['Eval', ...experiments.map(e => e.padStart(18))]
  console.log(header.join('  '))
  console.log('-'.repeat(header.join('  ').length))

  for (const evalName of allEvals) {
    const cells = [evalName.padEnd(30)]
    for (const r of results) {
      const ev = r.evals.find(e => e.eval === evalName)
      if (ev) {
        cells.push(`${pct(ev.passRate)} (${ev.passCount}/${ev.totalRuns})`.padStart(18))
      }
      else {
        cells.push('-'.padStart(18))
      }
    }
    console.log(cells.join('  '))
  }

  // Overall row
  console.log('-'.repeat(header.join('  ').length))
  const overallCells = ['OVERALL'.padEnd(30)]
  for (const r of results) {
    overallCells.push(`${pct(r.overall.passRate)} (${r.overall.passCount}/${r.overall.totalRuns})`.padStart(18))
  }
  console.log(overallCells.join('  '))

  // Duration
  console.log('\n## Mean Duration by Eval (seconds)')
  console.log('')
  console.log(header.join('  '))
  console.log('-'.repeat(header.join('  ').length))

  for (const evalName of allEvals) {
    const cells = [evalName.padEnd(30)]
    for (const r of results) {
      const ev = r.evals.find(e => e.eval === evalName)
      cells.push(ev ? sec(ev.meanDuration).padStart(18) : '-'.padStart(18))
    }
    console.log(cells.join('  '))
  }

  // Token usage
  console.log('\n## Token Usage (total across all runs)')
  console.log('')
  const tokenHeader = ['Experiment', 'Input (new)', 'Cache Write', 'Cache Read', 'Total Input', 'Output', 'Est. Cost']
  console.log(tokenHeader.map((h, i) => i === 0 ? h.padEnd(22) : h.padStart(12)).join('  '))
  console.log('-'.repeat(110))

  for (const r of results) {
    const u = r.overall.totalUsage
    const cells = [
      r.experiment.padEnd(22),
      num(u.input).padStart(12),
      num(u.cacheCreation).padStart(12),
      num(u.cacheRead).padStart(12),
      num(totalInput(u)).padStart(12),
      num(u.output).padStart(12),
      dollar(r.overall.estimatedCost).padStart(12),
    ]
    console.log(cells.join('  '))
  }

  // Tool call patterns
  console.log('\n## Tool Call Patterns (total across all runs)')
  console.log('')
  const toolHeader = ['Experiment', 'Total', 'Read', 'Write', 'Edit', 'Shell', 'Glob', 'Grep', 'WebFetch', 'Turns']
  console.log(toolHeader.map((h, i) => i === 0 ? h.padEnd(22) : h.padStart(8)).join('  '))
  console.log('-'.repeat(105))

  for (const r of results) {
    const tc = r.evals.reduce((acc, e) => {
      for (const run of e.runs) {
        acc.total += run.totalToolCalls
        acc.read += run.toolCalls.file_read
        acc.write += run.toolCalls.file_write
        acc.edit += run.toolCalls.file_edit
        acc.shell += run.toolCalls.shell
        acc.glob += run.toolCalls.glob
        acc.grep += run.toolCalls.grep
        acc.webFetch += run.toolCalls.web_fetch
        acc.turns += run.totalTurns
      }
      return acc
    }, { total: 0, read: 0, write: 0, edit: 0, shell: 0, glob: 0, grep: 0, webFetch: 0, turns: 0 })

    console.log([
      r.experiment.padEnd(22),
      String(tc.total).padStart(8),
      String(tc.read).padStart(8),
      String(tc.write).padStart(8),
      String(tc.edit).padStart(8),
      String(tc.shell).padStart(8),
      String(tc.glob).padStart(8),
      String(tc.grep).padStart(8),
      String(tc.webFetch).padStart(8),
      String(tc.turns).padStart(8),
    ].join('  '))
  }

  // Errors
  const hasErrors = results.some(r => r.evals.some(e => e.runs.some(run => run.errors.length > 0)))
  if (hasErrors) {
    console.log('\n## Errors')
    for (const r of results) {
      for (const e of r.evals) {
        for (let i = 0; i < e.runs.length; i++) {
          const run = e.runs[i]
          if (run.errors.length > 0) {
            console.log(`  ${r.experiment}/${e.eval}/run-${i + 1}: ${run.errors.join(', ')}`)
          }
        }
      }
    }
  }

  console.log('')
}

// --- CSV output ---

function printCSV(results: ExperimentSummary[]) {
  const headers = [
    'experiment', 'eval', 'run', 'status', 'duration_s',
    'input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'total_input_tokens', 'output_tokens',
    'est_cost_usd', 'total_tool_calls', 'turns', 'model',
  ]
  console.log(headers.join(','))

  for (const r of results) {
    for (const e of r.evals) {
      for (let i = 0; i < e.runs.length; i++) {
        const run = e.runs[i]
        const u = run.usage
        const ti = totalInput(u)
        console.log([
          r.experiment, e.eval, i + 1, run.status, run.duration.toFixed(1),
          u.input, u.cacheCreation, u.cacheRead, ti, u.output,
          estimateCost(u).toFixed(6), run.totalToolCalls, run.totalTurns, run.model,
        ].join(','))
      }
    }
  }
}

// --- JSON output ---

function printJSON(results: ExperimentSummary[]) {
  console.log(JSON.stringify(results, null, 2))
}

// --- Main ---

function main() {
  const args = process.argv.slice(2)
  const format = args.includes('--json') ? 'json' : args.includes('--csv') ? 'csv' : 'table'
  const tsIdx = args.indexOf('--timestamp')
  const targetTimestamp = tsIdx !== -1 ? args[tsIdx + 1] : undefined

  const resultsDir = resolve(import.meta.dirname ?? '.', 'results')
  if (!existsSync(resultsDir)) {
    console.error('No results directory found. Run evals first.')
    process.exit(1)
  }

  const experiments = readdirSync(resultsDir)
    .filter(e => statSync(join(resultsDir, e)).isDirectory())
    .sort()

  const results: ExperimentSummary[] = []
  for (const exp of experiments) {
    const summary = parseExperiment(resultsDir, exp, targetTimestamp)
    if (summary)
      results.push(summary)
  }

  if (results.length === 0) {
    console.error('No results found.')
    process.exit(1)
  }

  switch (format) {
    case 'json': printJSON(results); break
    case 'csv': printCSV(results); break
    default: printTable(results)
  }
}

main()
