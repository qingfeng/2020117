#!/usr/bin/env node
/**
 * Pipeline — chain multiple P2P providers in sequence.
 *
 * Usage:
 *   BUDGET_SATS=100 TARGET_LANG=Chinese npm run pipeline "Write a short poem"
 */

import { streamFromProvider } from './p2p-customer.js'
import { getOnlineProviders } from './api.js'

const BUDGET_SATS = Number(process.env.BUDGET_SATS) || 100
const MAX_SATS_PER_CHUNK = Number(process.env.MAX_SATS_PER_CHUNK) || 5
const GEN_KIND = Number(process.env.GEN_KIND) || 5100
const TRANS_KIND = Number(process.env.TRANS_KIND) || 5302
const TARGET_LANG = process.env.TARGET_LANG || 'Chinese'

async function showProviders(kind: number, label: string) {
  try {
    const agents = await getOnlineProviders(kind)
    if (agents.length === 0) {
      console.log(`[${label}] No providers online for kind ${kind}`)
    } else {
      console.log(`[${label}] ${agents.length} provider(s) online for kind ${kind}:`)
      for (const a of agents) {
        const cap = a.capacity !== undefined ? `, capacity: ${a.capacity}` : ''
        const price = a.pricing ? `, pricing: ${JSON.stringify(a.pricing)}` : ''
        console.log(`[${label}]   - ${a.username || a.user_id} (${a.status}${cap}${price})`)
      }
    }
  } catch {
    console.log(`[${label}] Could not query platform`)
  }
}

async function collectStream(opts: Parameters<typeof streamFromProvider>[0]): Promise<string> {
  let output = ''
  for await (const chunk of streamFromProvider(opts)) {
    process.stdout.write(chunk)
    output += chunk
  }
  return output
}

async function main() {
  const prompt = process.argv.slice(2).join(' ')
  if (!prompt) {
    console.error('Usage: BUDGET_SATS=100 TARGET_LANG=Chinese npm run pipeline "your prompt"')
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log(`Pipeline: generate (kind ${GEN_KIND}) → translate to ${TARGET_LANG} (kind ${TRANS_KIND})`)
  console.log(`Total budget: ${BUDGET_SATS} sats`)
  console.log('='.repeat(60))

  const genBudget = Math.ceil(BUDGET_SATS * 0.6)
  const transBudget = BUDGET_SATS - genBudget

  // Phase 1: Text Generation
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Phase 1: Text Generation (budget: ${genBudget} sats)`)
  console.log('─'.repeat(60))
  await showProviders(GEN_KIND, 'gen')

  const generated = await collectStream({
    kind: GEN_KIND, input: prompt, budgetSats: genBudget,
    maxSatsPerChunk: MAX_SATS_PER_CHUNK, label: 'gen',
  })

  if (!generated.trim()) {
    console.error('\n[pipeline] Phase 1 produced no output, aborting')
    process.exit(1)
  }

  // Phase 2: Translation
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Phase 2: Translation to ${TARGET_LANG} (budget: ${transBudget} sats)`)
  console.log('─'.repeat(60))
  await showProviders(TRANS_KIND, 'trans')

  const translated = await collectStream({
    kind: TRANS_KIND, input: `Translate the following text to ${TARGET_LANG}:\n\n${generated}`,
    budgetSats: transBudget, maxSatsPerChunk: MAX_SATS_PER_CHUNK, label: 'trans',
  })

  // Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log('Pipeline complete!')
  console.log('='.repeat(60))
  console.log(`\nGenerated (${generated.length} chars):\n${generated}`)
  console.log(`\nTranslated (${translated.length} chars):\n${translated}`)
}

main().catch(err => { console.error('[pipeline] Fatal:', err.message || err); process.exit(1) })
