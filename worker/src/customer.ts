#!/usr/bin/env node
/**
 * Customer client — streaming payment mode
 *
 * Usage:
 *   BUDGET_SATS=50 npx tsx src/customer.ts "Explain quantum computing"
 *
 * Flow:
 *   1. Mint a big Cashu token, split into micro-tokens
 *   2. Join Hyperswarm topic to find provider
 *   3. Send request with budget
 *   4. Receive offer → verify price is acceptable
 *   5. Send first micro-token → unlock first batch of chunks
 *   6. On pay_required → auto-send next micro-token
 *   7. On budget exhausted → send stop
 *   8. On result → done
 */

// --- CLI args → env (for npx usage) ---
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
  }
}

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { mintTokens, splitTokens } from './cashu.js'
import { randomBytes } from 'crypto'

const KIND = Number(process.env.DVM_KIND) || 5100
const BUDGET_SATS = Number(process.env.BUDGET_SATS) || 100
const MAX_SATS_PER_CHUNK = Number(process.env.MAX_SATS_PER_CHUNK) || 5

async function main() {
  const prompt = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ')
  if (!prompt) {
    console.error('Usage: BUDGET_SATS=50 npx tsx src/customer.ts "your prompt here"')
    process.exit(1)
  }

  const jobId = randomBytes(8).toString('hex')
  console.log(`[customer] Job ${jobId}: "${prompt.slice(0, 60)}..."`)
  console.log(`[customer] Budget: ${BUDGET_SATS} sats, max price: ${MAX_SATS_PER_CHUNK} sat/chunk`)

  // --- Step 1: Mint tokens ---
  console.log(`[customer] Minting ${BUDGET_SATS} sats (testnut)...`)
  let bigToken: string | undefined
  try {
    const minted = await mintTokens(BUDGET_SATS)
    bigToken = minted.token
    console.log(`[customer] Token ready: ${bigToken.slice(0, 40)}...`)
  } catch (e: any) {
    console.error(`[customer] Mint failed: ${e.message}`)
    process.exit(1)
  }

  // --- Step 2: Connect to Hyperswarm ---
  const node = new SwarmNode()
  const topic = topicFromKind(KIND)

  console.log(`[customer] Looking for providers (kind ${KIND})...`)
  await node.connect(topic)

  let peer: { socket: any; peerId: string }
  try {
    peer = await node.waitForPeer(30000)
  } catch {
    console.error('[customer] No provider found within 30s. Is a provider running?')
    await node.destroy()
    process.exit(1)
  }

  console.log(`[customer] Connected to provider: ${peer.peerId.slice(0, 12)}...`)

  // --- Step 3: Send request and handle streaming payment ---
  return new Promise<void>((resolve) => {
    let microTokens: string[] = []
    let tokenIndex = 0
    let streaming = false
    let satsPerPayment = 0  // set after receiving offer

    node.on('message', async (msg: SwarmMessage) => {
      switch (msg.type) {
        case 'offer': {
          const spc = msg.sats_per_chunk ?? 0
          const cpp = msg.chunks_per_payment ?? 0
          satsPerPayment = spc * cpp

          console.log(`[customer] Offer: ${spc} sat/chunk, ${cpp} chunks/payment (${satsPerPayment} sats/cycle)`)

          // Check if price is acceptable
          if (spc > MAX_SATS_PER_CHUNK) {
            console.error(`[customer] Price too high: ${spc} sat/chunk > max ${MAX_SATS_PER_CHUNK}`)
            node.send(peer.socket, { type: 'stop', id: jobId })
            await cleanup()
            return
          }

          if (satsPerPayment <= 0) {
            console.error(`[customer] Invalid offer: sats_per_payment = 0`)
            await cleanup()
            return
          }

          // Split tokens into micro-payments
          console.log(`[customer] Splitting ${BUDGET_SATS} sats into ${satsPerPayment}-sat micro-tokens...`)
          try {
            microTokens = await splitTokens(bigToken!, satsPerPayment)
            console.log(`[customer] Ready: ${microTokens.length} micro-tokens`)
          } catch (e: any) {
            console.error(`[customer] Split failed: ${e.message}`)
            await cleanup()
            return
          }

          if (microTokens.length === 0) {
            console.error(`[customer] Budget too small for payment cycle`)
            await cleanup()
            return
          }

          // Send first payment
          sendNextPayment()
          break
        }

        case 'payment_ack':
          console.log(`[customer] Payment confirmed: ${msg.amount} sats`)
          break

        case 'accepted':
          console.log(`[customer] Job accepted, streaming...\n`)
          streaming = true
          break

        case 'chunk':
          if (streaming) {
            process.stdout.write(msg.data || '')
          }
          break

        case 'pay_required':
          console.log(`\n[customer] Payment required (provider earned: ${msg.earned} sats, next: ${msg.next} sats)`)
          if (tokenIndex < microTokens.length) {
            sendNextPayment()
          } else {
            console.log(`[customer] Budget exhausted, sending stop`)
            node.send(peer.socket, { type: 'stop', id: jobId })
          }
          break

        case 'result':
          if (streaming) {
            console.log('\n')
          }
          console.log(`[customer] Job completed (${(msg.output || '').length} chars, ${msg.total_sats ?? '?'} sats total)`)
          await cleanup()
          break

        case 'error':
          console.error(`[customer] Error: ${msg.message}`)
          await cleanup()
          break
      }
    })

    function sendNextPayment() {
      if (tokenIndex >= microTokens.length) return
      const token = microTokens[tokenIndex++]
      console.log(`[customer] Sending payment ${tokenIndex}/${microTokens.length}`)
      node.send(peer.socket, { type: 'payment', id: jobId, token })
    }

    // Send request with budget
    node.send(peer.socket, {
      type: 'request',
      id: jobId,
      kind: KIND,
      input: prompt,
      budget: BUDGET_SATS,
    })

    async function cleanup() {
      await node.destroy()
      resolve()
    }

    // Handle Ctrl+C — send stop before exiting
    process.on('SIGINT', async () => {
      console.log('\n[customer] Interrupted, sending stop...')
      node.send(peer.socket, { type: 'stop', id: jobId })
      // Give provider a moment to process
      setTimeout(async () => {
        await node.destroy()
        process.exit(0)
      }, 1000)
    })

    // Timeout safety
    setTimeout(async () => {
      console.error('\n[customer] Timeout after 120s')
      await cleanup()
    }, 120000)
  })
}

main().catch(err => {
  console.error('[customer] Fatal:', err)
  process.exit(1)
})
