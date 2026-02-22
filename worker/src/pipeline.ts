#!/usr/bin/env node
/**
 * Pipeline — chain multiple DVM providers in sequence
 *
 * Usage:
 *   BUDGET_SATS=100 TARGET_LANG=Chinese npm run pipeline "Write a short poem about the moon"
 *
 * Flow:
 *   Phase 1: Connect to Provider A (text generation, kind 5100)
 *            → stream output with micro-payments → collect full text
 *   Phase 2: Connect to Provider B (translation, kind 5302)
 *            → feed Phase 1 output as input → stream translated output
 *
 * Each phase independently mints tokens, negotiates price, and pays per chunk.
 */

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { mintTokens, splitTokens } from './cashu.js'
import { randomBytes } from 'crypto'

const BUDGET_SATS = Number(process.env.BUDGET_SATS) || 100
const MAX_SATS_PER_CHUNK = Number(process.env.MAX_SATS_PER_CHUNK) || 5
const GEN_KIND = Number(process.env.GEN_KIND) || 5100
const TRANS_KIND = Number(process.env.TRANS_KIND) || 5302
const TARGET_LANG = process.env.TARGET_LANG || 'Chinese'

/**
 * Run a single pipeline step: mint → connect → offer → split → pay → collect output → destroy
 */
async function runStep(opts: {
  kind: number
  prompt: string
  budgetSats: number
  label: string
  maxSatsPerChunk: number
}): Promise<string> {
  const { kind, prompt, budgetSats, label, maxSatsPerChunk } = opts
  const jobId = randomBytes(8).toString('hex')

  console.log(`[${label}] Job ${jobId}: "${prompt.slice(0, 60)}..."`)
  console.log(`[${label}] Budget: ${budgetSats} sats, max price: ${maxSatsPerChunk} sat/chunk`)

  // --- Mint tokens ---
  console.log(`[${label}] Minting ${budgetSats} sats...`)
  let bigToken: string
  try {
    const minted = await mintTokens(budgetSats)
    bigToken = minted.token
    console.log(`[${label}] Token ready: ${bigToken.slice(0, 40)}...`)
  } catch (e: any) {
    throw new Error(`[${label}] Mint failed: ${e.message}`)
  }

  // --- Connect to provider ---
  const node = new SwarmNode()
  const topic = topicFromKind(kind)

  console.log(`[${label}] Looking for providers (kind ${kind})...`)
  await node.connect(topic)

  let peer: { socket: any; peerId: string }
  try {
    peer = await node.waitForPeer(30000)
  } catch {
    await node.destroy()
    throw new Error(`[${label}] No provider found within 30s`)
  }

  console.log(`[${label}] Connected to provider: ${peer.peerId.slice(0, 12)}...`)

  // --- Streaming payment loop ---
  return new Promise<string>((resolve, reject) => {
    let microTokens: string[] = []
    let tokenIndex = 0
    let output = ''

    const cleanup = async () => {
      clearTimeout(timer)
      await node.destroy()
    }

    node.on('message', async (msg: SwarmMessage) => {
      switch (msg.type) {
        case 'offer': {
          const spc = msg.sats_per_chunk ?? 0
          const cpp = msg.chunks_per_payment ?? 0
          const satsPerPayment = spc * cpp

          console.log(`[${label}] Offer: ${spc} sat/chunk, ${cpp} chunks/payment (${satsPerPayment} sats/cycle)`)

          if (spc > maxSatsPerChunk) {
            node.send(peer.socket, { type: 'stop', id: jobId })
            await cleanup()
            reject(new Error(`[${label}] Price too high: ${spc} sat/chunk > max ${maxSatsPerChunk}`))
            return
          }

          if (satsPerPayment <= 0) {
            await cleanup()
            reject(new Error(`[${label}] Invalid offer: sats_per_payment = 0`))
            return
          }

          console.log(`[${label}] Splitting ${budgetSats} sats into ${satsPerPayment}-sat micro-tokens...`)
          try {
            microTokens = await splitTokens(bigToken, satsPerPayment)
            console.log(`[${label}] Ready: ${microTokens.length} micro-tokens`)
          } catch (e: any) {
            await cleanup()
            reject(new Error(`[${label}] Split failed: ${e.message}`))
            return
          }

          if (microTokens.length === 0) {
            await cleanup()
            reject(new Error(`[${label}] Budget too small for payment cycle`))
            return
          }

          sendNextPayment()
          break
        }

        case 'payment_ack':
          console.log(`[${label}] Payment confirmed: ${msg.amount} sats`)
          break

        case 'accepted':
          console.log(`[${label}] Job accepted, streaming...\n`)
          break

        case 'chunk':
          if (msg.data) {
            process.stdout.write(msg.data)
            output += msg.data
          }
          break

        case 'pay_required':
          console.log(`\n[${label}] Payment required (earned: ${msg.earned} sats, next: ${msg.next} sats)`)
          if (tokenIndex < microTokens.length) {
            sendNextPayment()
          } else {
            console.log(`[${label}] Budget exhausted, sending stop`)
            node.send(peer.socket, { type: 'stop', id: jobId })
          }
          break

        case 'result':
          console.log(`\n[${label}] Done (${(msg.output || '').length} chars, ${msg.total_sats ?? '?'} sats)`)
          await cleanup()
          resolve(output || msg.output || '')
          break

        case 'error':
          await cleanup()
          reject(new Error(`[${label}] Provider error: ${msg.message}`))
          break
      }
    })

    function sendNextPayment() {
      if (tokenIndex >= microTokens.length) return
      const token = microTokens[tokenIndex++]
      console.log(`[${label}] Sending payment ${tokenIndex}/${microTokens.length}`)
      node.send(peer.socket, { type: 'payment', id: jobId, token })
    }

    // Send request
    node.send(peer.socket, {
      type: 'request',
      id: jobId,
      kind,
      input: prompt,
      budget: budgetSats,
    })

    // Timeout safety
    const timer = setTimeout(async () => {
      await cleanup()
      reject(new Error(`[${label}] Timeout after 120s`))
    }, 120000)
  })
}

async function main() {
  const prompt = process.argv.slice(2).join(' ')
  if (!prompt) {
    console.error('Usage: BUDGET_SATS=100 TARGET_LANG=Chinese npm run pipeline "your prompt here"')
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

  const generated = await runStep({
    kind: GEN_KIND,
    prompt,
    budgetSats: genBudget,
    label: 'gen',
    maxSatsPerChunk: MAX_SATS_PER_CHUNK,
  })

  if (!generated.trim()) {
    console.error('\n[pipeline] Phase 1 produced no output, aborting')
    process.exit(1)
  }

  // Phase 2: Translation
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Phase 2: Translation to ${TARGET_LANG} (budget: ${transBudget} sats)`)
  console.log('─'.repeat(60))

  const translated = await runStep({
    kind: TRANS_KIND,
    prompt: `Translate the following text to ${TARGET_LANG}:\n\n${generated}`,
    budgetSats: transBudget,
    label: 'trans',
    maxSatsPerChunk: MAX_SATS_PER_CHUNK,
  })

  // Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log('Pipeline complete!')
  console.log('='.repeat(60))
  console.log(`\nGenerated (${generated.length} chars):\n${generated}`)
  console.log(`\nTranslated (${translated.length} chars):\n${translated}`)
}

main().catch(err => {
  console.error('[pipeline] Fatal:', err.message || err)
  process.exit(1)
})
