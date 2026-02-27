#!/usr/bin/env node
/**
 * Standalone P2P Customer — connects to a provider, streams results with CLINK debit payments.
 *
 * Usage:
 *   2020117-customer --kind=5100 --budget=50 --ndebit=ndebit1... "Explain quantum computing"
 */

// --- CLI args → env (before any imports) ---
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue
  const eq = arg.indexOf('=')
  if (eq === -1) continue
  const key = arg.slice(0, eq)
  const val = arg.slice(eq + 1)
  switch (key) {
    case '--kind':      process.env.DVM_KIND = val; break
    case '--budget':    process.env.BUDGET_SATS = val; break
    case '--max-price': process.env.MAX_SATS_PER_CHUNK = val; break
    case '--ndebit':    process.env.CLINK_NDEBIT = val; break
  }
}

import { streamFromProvider } from './p2p-customer.js'

const KIND = Number(process.env.DVM_KIND) || 5100
const BUDGET_SATS = Number(process.env.BUDGET_SATS) || 100
const MAX_SATS_PER_CHUNK = Number(process.env.MAX_SATS_PER_CHUNK) || 5
const NDEBIT = process.env.CLINK_NDEBIT || ''

async function main() {
  const prompt = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ')
  if (!prompt) {
    console.error('Usage: 2020117-customer --kind=5100 --budget=50 --ndebit=ndebit1... "your prompt here"')
    process.exit(1)
  }

  if (!NDEBIT) {
    console.error('[customer] Error: --ndebit=ndebit1... required (CLINK debit authorization)')
    process.exit(1)
  }

  console.log(`[customer] Prompt: "${prompt.slice(0, 60)}..."`)
  console.log(`[customer] Budget: ${BUDGET_SATS} sats, max price: ${MAX_SATS_PER_CHUNK} sat/chunk`)

  // Stream from provider (handles connection, negotiation, CLINK payments internally)
  let output = ''
  for await (const chunk of streamFromProvider({
    kind: KIND,
    input: prompt,
    budgetSats: BUDGET_SATS,
    ndebit: NDEBIT,
    maxSatsPerChunk: MAX_SATS_PER_CHUNK,
    label: 'customer',
  })) {
    process.stdout.write(chunk)
    output += chunk
  }

  console.log(`\n[customer] Done (${output.length} chars)`)
}

main().catch(err => { console.error('[customer] Fatal:', err.message || err); process.exit(1) })
