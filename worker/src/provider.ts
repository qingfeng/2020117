#!/usr/bin/env node
/**
 * Provider daemon — streaming payment mode
 *
 * Usage:
 *   SATS_PER_CHUNK=1 CHUNKS_PER_PAYMENT=10 npx tsx src/provider.ts
 *
 * Flow:
 *   1. Join Hyperswarm topic for kind 5100 (text generation)
 *   2. Wait for customer connections
 *   3. Receive request → send offer (price quote)
 *   4. Receive first payment → peek to verify, start generating
 *   5. Stream N chunks per payment cycle
 *   6. Pause and send pay_required → wait for next payment
 *   7. On completion or stop → send result, batch claim all tokens
 */

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { receiveToken, peekToken } from './cashu.js'
import { generateStream, listModels } from './adapters/ollama.js'

const KIND = Number(process.env.DVM_KIND) || 5100
const SATS_PER_CHUNK = Number(process.env.SATS_PER_CHUNK) || 1
const CHUNKS_PER_PAYMENT = Number(process.env.CHUNKS_PER_PAYMENT) || 10
const PAYMENT_TIMEOUT = Number(process.env.PAYMENT_TIMEOUT) || 30000
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2'

interface JobState {
  socket: any
  credit: number              // chunks still allowed before next payment
  tokens: string[]            // accumulated tokens (claimed at the end)
  totalEarned: number         // total sats earned
  stopped: boolean            // customer sent stop
  paymentResolve: (() => void) | null  // resolves when payment arrives
}

const jobs = new Map<string, JobState>()

async function main() {
  // Verify Ollama is running
  console.log(`[provider] Checking Ollama (model: ${MODEL})...`)
  try {
    const models = await listModels()
    if (!models.some(m => m.startsWith(MODEL))) {
      console.warn(`[provider] Model "${MODEL}" not found. Available: ${models.join(', ')}`)
      console.warn(`[provider] Run: ollama pull ${MODEL}`)
      process.exit(1)
    }
    console.log(`[provider] Ollama OK — model "${MODEL}" available`)
  } catch (e: any) {
    console.error(`[provider] Ollama not reachable: ${e.message}`)
    console.error(`[provider] Make sure Ollama is running: ollama serve`)
    process.exit(1)
  }

  const satsPerPayment = SATS_PER_CHUNK * CHUNKS_PER_PAYMENT
  const node = new SwarmNode()
  const topic = topicFromKind(KIND)

  console.log(`[provider] Streaming payment: ${SATS_PER_CHUNK} sat/chunk, ${CHUNKS_PER_PAYMENT} chunks/payment (${satsPerPayment} sats/cycle)`)
  console.log(`[provider] Joining topic for kind ${KIND}`)
  await node.listen(topic)
  console.log(`[provider] Listening for customers...\n`)

  node.on('message', async (msg: SwarmMessage, socket: any, peerId: string) => {
    const tag = peerId.slice(0, 8)

    if (msg.type === 'request') {
      console.log(`[provider] Job ${msg.id} from ${tag}: "${(msg.input || '').slice(0, 60)}..."`)
      if (msg.budget !== undefined) {
        console.log(`[provider] Customer budget: ${msg.budget} sats`)
      }

      // Initialize job state
      const job: JobState = {
        socket,
        credit: 0,
        tokens: [],
        totalEarned: 0,
        stopped: false,
        paymentResolve: null,
      }
      jobs.set(msg.id, job)

      // Send offer
      node.send(socket, {
        type: 'offer',
        id: msg.id,
        sats_per_chunk: SATS_PER_CHUNK,
        chunks_per_payment: CHUNKS_PER_PAYMENT,
      })
      console.log(`[provider] Sent offer: ${SATS_PER_CHUNK} sat/chunk, ${CHUNKS_PER_PAYMENT} chunks/payment`)

      // Wait for first payment before starting
      const paid = await waitForPayment(job, msg.id, node)
      if (!paid) {
        console.log(`[provider] Job ${msg.id}: no initial payment, aborting`)
        jobs.delete(msg.id)
        return
      }

      // Start generating
      node.send(socket, { type: 'accepted', id: msg.id })
      await runGeneration(node, job, msg)
    }

    if (msg.type === 'payment') {
      const job = jobs.get(msg.id)
      if (!job) return

      if (!msg.token) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Payment missing token' })
        return
      }

      try {
        const peek = peekToken(msg.token)
        const chunksUnlocked = Math.floor(peek.amount / SATS_PER_CHUNK)
        job.credit += chunksUnlocked
        job.totalEarned += peek.amount
        job.tokens.push(msg.token)

        console.log(`[provider] Payment for ${msg.id}: ${peek.amount} sats → +${chunksUnlocked} chunks (credit: ${job.credit}, total: ${job.totalEarned} sats)`)
        node.send(socket, { type: 'payment_ack', id: msg.id, amount: peek.amount })

        // Wake up generation loop if it's waiting
        if (job.paymentResolve) {
          job.paymentResolve()
          job.paymentResolve = null
        }
      } catch (e: any) {
        node.send(socket, { type: 'error', id: msg.id, message: `Payment failed: ${e.message}` })
      }
    }

    if (msg.type === 'stop') {
      const job = jobs.get(msg.id)
      if (!job) return

      console.log(`[provider] Job ${msg.id}: customer requested stop`)
      job.stopped = true
      // Wake up generation loop if waiting for payment
      if (job.paymentResolve) {
        job.paymentResolve()
        job.paymentResolve = null
      }
    }
  })

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[provider] Shutting down...')
    await node.destroy()
    process.exit(0)
  })
}

function waitForPayment(job: JobState, jobId: string, node: SwarmNode): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      job.paymentResolve = null
      console.log(`[provider] Job ${jobId}: payment timeout (${PAYMENT_TIMEOUT}ms)`)
      node.send(job.socket, {
        type: 'error',
        id: jobId,
        message: `Payment timeout after ${PAYMENT_TIMEOUT}ms`,
      })
      resolve(false)
    }, PAYMENT_TIMEOUT)

    job.paymentResolve = () => {
      clearTimeout(timer)
      resolve(true)
    }

    // If already has credit (shouldn't happen for initial, but just in case)
    if (job.credit > 0) {
      clearTimeout(timer)
      job.paymentResolve = null
      resolve(true)
    }
  })
}

async function runGeneration(node: SwarmNode, job: JobState, msg: SwarmMessage) {
  const jobId = msg.id
  let fullOutput = ''

  try {
    for await (const chunk of generateStream({ model: MODEL, prompt: msg.input || '' })) {
      // Check for stop
      if (job.stopped) {
        console.log(`[provider] Job ${jobId}: stopped by customer`)
        break
      }

      // Check credit
      if (job.credit <= 0) {
        // Ask for more payment
        const nextAmount = SATS_PER_CHUNK * CHUNKS_PER_PAYMENT
        node.send(job.socket, {
          type: 'pay_required',
          id: jobId,
          earned: job.totalEarned,
          next: nextAmount,
        })
        console.log(`[provider] Job ${jobId}: pay_required (earned: ${job.totalEarned}, next: ${nextAmount})`)

        // Wait for payment or timeout
        const paid = await waitForPayment(job, jobId, node)
        if (!paid || job.stopped) {
          console.log(`[provider] Job ${jobId}: ending (paid=${paid}, stopped=${job.stopped})`)
          break
        }
      }

      // Send chunk
      fullOutput += chunk
      node.send(job.socket, { type: 'chunk', id: jobId, data: chunk })
      job.credit--
    }
  } catch (e: any) {
    console.error(`[provider] Job ${jobId} generation error: ${e.message}`)
    node.send(job.socket, { type: 'error', id: jobId, message: e.message })
  }

  // Send result
  node.send(job.socket, {
    type: 'result',
    id: jobId,
    output: fullOutput,
    total_sats: job.totalEarned,
  })
  console.log(`[provider] Job ${jobId} completed (${fullOutput.length} chars, ${job.totalEarned} sats earned)`)

  // Batch claim all accumulated tokens
  await batchClaim(job.tokens, jobId)
  jobs.delete(jobId)
}

async function batchClaim(tokens: string[], jobId: string) {
  if (tokens.length === 0) return

  console.log(`[provider] Job ${jobId}: claiming ${tokens.length} tokens...`)
  let totalClaimed = 0

  for (let i = 0; i < tokens.length; i++) {
    try {
      const received = await receiveToken(tokens[i])
      totalClaimed += received.amount
    } catch (e: any) {
      console.warn(`[provider] Job ${jobId}: claim ${i + 1}/${tokens.length} failed: ${e.message}`)
    }
  }

  console.log(`[provider] Job ${jobId}: claimed ${totalClaimed} sats total`)
}

main().catch(err => {
  console.error('[provider] Fatal:', err)
  process.exit(1)
})
