#!/usr/bin/env node
/**
 * Unified Agent Runtime — runs as a long-lived daemon that handles both:
 *   1. Async platform tasks (inbox polling → accept → Ollama → submit result)
 *   2. Real-time P2P streaming (Hyperswarm + Cashu micro-payments)
 *
 * Both channels share a single capacity counter so the agent never overloads.
 *
 * Usage:
 *   AGENT=translator DVM_KIND=5302 OLLAMA_MODEL=qwen2.5:0.5b npm run agent
 *   AGENT=my-agent DVM_KIND=5100 MAX_JOBS=5 npm run agent
 *   DVM_KIND=5100 npm run agent          # no API key → P2P-only mode
 */

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { receiveToken, peekToken } from './cashu.js'
import { generate, generateStream, listModels } from './adapters/ollama.js'
import {
  hasApiKey, loadAgentName, registerService, startHeartbeatLoop,
  getInbox, acceptJob, sendFeedback, submitResult,
} from './api.js'

// --- Config from env ---

const KIND = Number(process.env.DVM_KIND) || 5100
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2'
const MAX_CONCURRENT = Number(process.env.MAX_JOBS) || 3
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL) || 30_000
const SATS_PER_CHUNK = Number(process.env.SATS_PER_CHUNK) || 1
const CHUNKS_PER_PAYMENT = Number(process.env.CHUNKS_PER_PAYMENT) || 10
const PAYMENT_TIMEOUT = Number(process.env.PAYMENT_TIMEOUT) || 30_000

// --- State ---

interface AgentState {
  agentName: string | null
  activeJobs: number
  shuttingDown: boolean
  stopHeartbeat: (() => void) | null
  pollTimer: ReturnType<typeof setTimeout> | null
  swarmNode: SwarmNode | null
}

const state: AgentState = {
  agentName: loadAgentName(),
  activeJobs: 0,
  shuttingDown: false,
  stopHeartbeat: null,
  pollTimer: null,
  swarmNode: null,
}

// --- Capacity management ---

function acquireSlot(): boolean {
  if (state.shuttingDown) return false
  if (state.activeJobs >= MAX_CONCURRENT) return false
  state.activeJobs++
  return true
}

function releaseSlot(): void {
  if (state.activeJobs > 0) state.activeJobs--
}

function getAvailableCapacity(): number {
  return MAX_CONCURRENT - state.activeJobs
}

// --- Main ---

async function main() {
  const label = state.agentName || 'agent'
  console.log(`[${label}] Starting unified agent runtime`)
  console.log(`[${label}] kind=${KIND} model=${MODEL} maxJobs=${MAX_CONCURRENT}`)

  // 1. Verify Ollama
  await verifyOllama(label)

  // 2. Platform registration + heartbeat
  await setupPlatform(label)

  // 3. Async inbox poller
  startInboxPoller(label)

  // 4. P2P swarm listener
  await startSwarmListener(label)

  // 5. Graceful shutdown
  setupShutdown(label)

  console.log(`[${label}] Agent ready — async + P2P channels active\n`)
}

// --- 1. Verify Ollama ---

async function verifyOllama(label: string) {
  console.log(`[${label}] Checking Ollama (model: ${MODEL})...`)
  try {
    const models = await listModels()
    if (!models.some(m => m.startsWith(MODEL))) {
      console.error(`[${label}] Model "${MODEL}" not found. Available: ${models.join(', ')}`)
      console.error(`[${label}] Run: ollama pull ${MODEL}`)
      process.exit(1)
    }
    console.log(`[${label}] Ollama OK — model "${MODEL}" available`)
  } catch (e: any) {
    console.error(`[${label}] Ollama not reachable: ${e.message}`)
    console.error(`[${label}] Make sure Ollama is running: ollama serve`)
    process.exit(1)
  }
}

// --- 2. Platform registration ---

async function setupPlatform(label: string) {
  if (!hasApiKey()) {
    console.log(`[${label}] No API key — P2P-only mode (inbox polling disabled)`)
    return
  }
  console.log(`[${label}] Registering on platform...`)
  await registerService({
    kind: KIND,
    satsPerChunk: SATS_PER_CHUNK,
    chunksPerPayment: CHUNKS_PER_PAYMENT,
    model: MODEL,
  })
  state.stopHeartbeat = startHeartbeatLoop(() => getAvailableCapacity())
}

// --- 3. Async Inbox Poller ---

function startInboxPoller(label: string) {
  if (!hasApiKey()) return

  console.log(`[${label}] Inbox polling every ${POLL_INTERVAL / 1000}s`)

  async function poll() {
    if (state.shuttingDown) return

    try {
      if (getAvailableCapacity() <= 0) {
        // No capacity — skip this round
        scheduleNext()
        return
      }

      const jobs = await getInbox({ kind: KIND, status: 'open', limit: 5 })
      for (const job of jobs) {
        if (state.shuttingDown) break
        if (!acquireSlot()) break

        // Process in background — don't await
        processAsyncJob(label, job.id, job.input).catch((err) => {
          console.error(`[${label}] Async job ${job.id} error: ${err.message}`)
        })
      }
    } catch (e: any) {
      console.warn(`[${label}] Poll error: ${e.message}`)
    }

    scheduleNext()
  }

  function scheduleNext() {
    if (state.shuttingDown) return
    state.pollTimer = setTimeout(poll, POLL_INTERVAL)
  }

  // First poll after a short delay to let swarm set up
  state.pollTimer = setTimeout(poll, 2000)
}

async function processAsyncJob(label: string, inboxJobId: string, input: string) {
  try {
    console.log(`[${label}] Accepting job ${inboxJobId}...`)
    const accepted = await acceptJob(inboxJobId)
    if (!accepted) {
      console.warn(`[${label}] Failed to accept job ${inboxJobId}`)
      return
    }

    const providerJobId = accepted.job_id
    console.log(`[${label}] Job ${providerJobId}: processing "${input.slice(0, 60)}..."`)

    await sendFeedback(providerJobId, 'processing')

    // Non-streaming generate for platform (result must be submitted at once)
    const result = await generate({ model: MODEL, prompt: input })
    console.log(`[${label}] Job ${providerJobId}: generated ${result.length} chars`)

    const ok = await submitResult(providerJobId, result)
    if (ok) {
      console.log(`[${label}] Job ${providerJobId}: result submitted`)
    } else {
      console.warn(`[${label}] Job ${providerJobId}: failed to submit result`)
    }
  } finally {
    releaseSlot()
  }
}

// --- 4. P2P Swarm Listener ---

// Per-connection job state for P2P streaming
interface P2PJobState {
  socket: any
  credit: number
  tokens: string[]
  totalEarned: number
  stopped: boolean
  paymentResolve: (() => void) | null
}

const p2pJobs = new Map<string, P2PJobState>()

async function startSwarmListener(label: string) {
  const node = new SwarmNode()
  state.swarmNode = node

  const satsPerPayment = SATS_PER_CHUNK * CHUNKS_PER_PAYMENT
  const topic = topicFromKind(KIND)

  console.log(`[${label}] P2P: ${SATS_PER_CHUNK} sat/chunk, ${CHUNKS_PER_PAYMENT} chunks/payment (${satsPerPayment} sats/cycle)`)
  console.log(`[${label}] Joining swarm topic for kind ${KIND}`)
  await node.listen(topic)
  console.log(`[${label}] P2P listening for customers...`)

  node.on('message', async (msg: SwarmMessage, socket: any, peerId: string) => {
    const tag = peerId.slice(0, 8)

    if (msg.type === 'request') {
      console.log(`[${label}] P2P job ${msg.id} from ${tag}: "${(msg.input || '').slice(0, 60)}..."`)

      if (!acquireSlot()) {
        node.send(socket, {
          type: 'error',
          id: msg.id,
          message: `No capacity (${state.activeJobs}/${MAX_CONCURRENT} slots used)`,
        })
        console.log(`[${label}] P2P job ${msg.id}: rejected (no capacity)`)
        return
      }

      if (msg.budget !== undefined) {
        console.log(`[${label}] Customer budget: ${msg.budget} sats`)
      }

      const job: P2PJobState = {
        socket,
        credit: 0,
        tokens: [],
        totalEarned: 0,
        stopped: false,
        paymentResolve: null,
      }
      p2pJobs.set(msg.id, job)

      // Send offer
      node.send(socket, {
        type: 'offer',
        id: msg.id,
        sats_per_chunk: SATS_PER_CHUNK,
        chunks_per_payment: CHUNKS_PER_PAYMENT,
      })

      // Wait for first payment
      const paid = await waitForPayment(job, msg.id, node, label)
      if (!paid) {
        console.log(`[${label}] P2P job ${msg.id}: no initial payment, aborting`)
        p2pJobs.delete(msg.id)
        releaseSlot()
        return
      }

      // Start generating
      node.send(socket, { type: 'accepted', id: msg.id })
      await runP2PGeneration(node, job, msg, label)
    }

    if (msg.type === 'payment') {
      const job = p2pJobs.get(msg.id)
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

        console.log(`[${label}] Payment for ${msg.id}: ${peek.amount} sats → +${chunksUnlocked} chunks (credit: ${job.credit}, total: ${job.totalEarned} sats)`)
        node.send(socket, { type: 'payment_ack', id: msg.id, amount: peek.amount })

        if (job.paymentResolve) {
          job.paymentResolve()
          job.paymentResolve = null
        }
      } catch (e: any) {
        node.send(socket, { type: 'error', id: msg.id, message: `Payment failed: ${e.message}` })
      }
    }

    if (msg.type === 'stop') {
      const job = p2pJobs.get(msg.id)
      if (!job) return

      console.log(`[${label}] P2P job ${msg.id}: customer requested stop`)
      job.stopped = true
      if (job.paymentResolve) {
        job.paymentResolve()
        job.paymentResolve = null
      }
    }
  })
}

function waitForPayment(job: P2PJobState, jobId: string, node: SwarmNode, label: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      job.paymentResolve = null
      console.log(`[${label}] P2P job ${jobId}: payment timeout (${PAYMENT_TIMEOUT}ms)`)
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

    if (job.credit > 0) {
      clearTimeout(timer)
      job.paymentResolve = null
      resolve(true)
    }
  })
}

async function runP2PGeneration(node: SwarmNode, job: P2PJobState, msg: SwarmMessage, label: string) {
  const jobId = msg.id
  let fullOutput = ''

  try {
    for await (const chunk of generateStream({ model: MODEL, prompt: msg.input || '' })) {
      if (job.stopped) {
        console.log(`[${label}] P2P job ${jobId}: stopped by customer`)
        break
      }

      if (job.credit <= 0) {
        const nextAmount = SATS_PER_CHUNK * CHUNKS_PER_PAYMENT
        node.send(job.socket, {
          type: 'pay_required',
          id: jobId,
          earned: job.totalEarned,
          next: nextAmount,
        })
        console.log(`[${label}] P2P job ${jobId}: pay_required (earned: ${job.totalEarned}, next: ${nextAmount})`)

        const paid = await waitForPayment(job, jobId, node, label)
        if (!paid || job.stopped) {
          console.log(`[${label}] P2P job ${jobId}: ending (paid=${paid}, stopped=${job.stopped})`)
          break
        }
      }

      fullOutput += chunk
      node.send(job.socket, { type: 'chunk', id: jobId, data: chunk })
      job.credit--
    }
  } catch (e: any) {
    console.error(`[${label}] P2P job ${jobId} generation error: ${e.message}`)
    node.send(job.socket, { type: 'error', id: jobId, message: e.message })
  }

  // Send result
  node.send(job.socket, {
    type: 'result',
    id: jobId,
    output: fullOutput,
    total_sats: job.totalEarned,
  })
  console.log(`[${label}] P2P job ${jobId} completed (${fullOutput.length} chars, ${job.totalEarned} sats earned)`)

  // Batch claim all tokens
  await batchClaim(job.tokens, jobId, label)
  p2pJobs.delete(jobId)
  releaseSlot()
}

async function batchClaim(tokens: string[], jobId: string, label: string) {
  if (tokens.length === 0) return

  console.log(`[${label}] P2P job ${jobId}: claiming ${tokens.length} tokens...`)
  let totalClaimed = 0

  for (let i = 0; i < tokens.length; i++) {
    try {
      const received = await receiveToken(tokens[i])
      totalClaimed += received.amount
    } catch (e: any) {
      console.warn(`[${label}] P2P job ${jobId}: claim ${i + 1}/${tokens.length} failed: ${e.message}`)
    }
  }

  console.log(`[${label}] P2P job ${jobId}: claimed ${totalClaimed} sats total`)
}

// --- 5. Graceful shutdown ---

function setupShutdown(label: string) {
  const shutdown = async () => {
    if (state.shuttingDown) return
    state.shuttingDown = true
    console.log(`\n[${label}] Shutting down...`)

    // Stop poller & heartbeat
    if (state.pollTimer) clearTimeout(state.pollTimer)
    if (state.stopHeartbeat) state.stopHeartbeat()

    // Wait for active jobs to finish (max 10s)
    if (state.activeJobs > 0) {
      console.log(`[${label}] Waiting for ${state.activeJobs} active job(s)...`)
      const deadline = Date.now() + 10_000
      while (state.activeJobs > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500))
      }
      if (state.activeJobs > 0) {
        console.warn(`[${label}] ${state.activeJobs} job(s) still running, forcing exit`)
      }
    }

    // Destroy swarm
    if (state.swarmNode) {
      await state.swarmNode.destroy()
    }

    console.log(`[${label}] Goodbye`)
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// --- Entry point ---

main().catch(err => {
  console.error('[agent] Fatal:', err)
  process.exit(1)
})
