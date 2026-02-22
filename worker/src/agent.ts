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
 *   AGENT=broker DVM_KIND=5302 PROCESSOR=none SUB_KIND=5100 npm run agent
 *   AGENT=custom DVM_KIND=5100 PROCESSOR=exec:./my-model.sh npm run agent
 *   AGENT=remote DVM_KIND=5100 PROCESSOR=http://localhost:8080 npm run agent
 */

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { receiveToken, peekToken, mintTokens, splitTokens } from './cashu.js'
import { createProcessor, Processor } from './processor.js'
import {
  hasApiKey, loadAgentName, registerService, startHeartbeatLoop,
  getInbox, acceptJob, sendFeedback, submitResult,
  createJob, getJob,
} from './api.js'
import { randomBytes } from 'crypto'

// --- Config from env ---

const KIND = Number(process.env.DVM_KIND) || 5100
const MAX_CONCURRENT = Number(process.env.MAX_JOBS) || 3
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL) || 30_000
const SATS_PER_CHUNK = Number(process.env.SATS_PER_CHUNK) || 1
const CHUNKS_PER_PAYMENT = Number(process.env.CHUNKS_PER_PAYMENT) || 10
const PAYMENT_TIMEOUT = Number(process.env.PAYMENT_TIMEOUT) || 30_000

// --- Sub-task delegation config ---
const SUB_KIND = process.env.SUB_KIND ? Number(process.env.SUB_KIND) : null
const SUB_BUDGET = Number(process.env.SUB_BUDGET) || 50
const SUB_CHANNEL = process.env.SUB_CHANNEL || 'p2p'
const SUB_PROVIDER = process.env.SUB_PROVIDER || undefined
const SUB_BID = Number(process.env.SUB_BID) || 100
const MAX_SATS_PER_CHUNK = Number(process.env.MAX_SATS_PER_CHUNK) || 5
const SUB_BATCH_SIZE = Number(process.env.SUB_BATCH_SIZE) || 500 // chars to accumulate before local processing

// --- State ---

interface AgentState {
  agentName: string | null
  activeJobs: number
  shuttingDown: boolean
  stopHeartbeat: (() => void) | null
  pollTimer: ReturnType<typeof setTimeout> | null
  swarmNode: SwarmNode | null
  processor: Processor | null
}

const state: AgentState = {
  agentName: loadAgentName(),
  activeJobs: 0,
  shuttingDown: false,
  stopHeartbeat: null,
  pollTimer: null,
  swarmNode: null,
  processor: null,
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

  // 1. Create and verify processor
  state.processor = await createProcessor()
  console.log(`[${label}] kind=${KIND} processor=${state.processor.name} maxJobs=${MAX_CONCURRENT}`)
  if (SUB_KIND) {
    console.log(`[${label}] Pipeline: sub-task kind=${SUB_KIND} via ${SUB_CHANNEL}${SUB_CHANNEL === 'api' ? ` (bid=${SUB_BID}${SUB_PROVIDER ? `, provider=${SUB_PROVIDER}` : ''})` : ` (budget=${SUB_BUDGET} sats)`}`)
  } else if (state.processor.name === 'none') {
    console.warn(`[${label}] WARNING: processor=none without SUB_KIND — generate() will pass through input as-is`)
  }
  await state.processor.verify()
  console.log(`[${label}] Processor "${state.processor.name}" verified`)

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
    model: state.processor?.name || 'unknown',
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

    let result: string

    // Pipeline: delegate sub-task then process locally
    if (SUB_KIND) {
      console.log(`[${label}] Job ${providerJobId}: delegating to kind ${SUB_KIND} via ${SUB_CHANNEL}...`)
      try {
        if (SUB_CHANNEL === 'api') {
          // API delegation is non-streaming — collect full result, then process
          const subResult = await delegateAPI(SUB_KIND, input, SUB_BID, SUB_PROVIDER)
          console.log(`[${label}] Job ${providerJobId}: sub-task returned ${subResult.length} chars`)
          result = await state.processor!.generate(subResult)
        } else {
          // P2P delegation — stream-collect from sub-provider, batch-translate
          result = ''
          for await (const chunk of pipelineStream(SUB_KIND, input, SUB_BUDGET)) {
            result += chunk
          }
        }
      } catch (e: any) {
        console.error(`[${label}] Job ${providerJobId}: sub-task failed: ${e.message}, using original input`)
        result = await state.processor!.generate(input)
      }
    } else {
      // No pipeline — direct local processing
      result = await state.processor!.generate(input)
    }

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

// --- Sub-task delegation ---

/**
 * Delegate a sub-task via Hyperswarm P2P with Cashu streaming payments.
 * Returns an AsyncGenerator that yields chunks as they arrive from the
 * remote provider — no buffering, true streaming.
 *
 * Creates a temporary SwarmNode (independent from the server listener).
 * The node is destroyed when the generator returns or throws.
 */
async function* delegateP2PStream(kind: number, input: string, budgetSats: number): AsyncGenerator<string> {
  const jobId = randomBytes(8).toString('hex')
  const tag = `sub-p2p-${jobId.slice(0, 8)}`

  console.log(`[${tag}] Minting ${budgetSats} sats...`)
  const { token: bigToken } = await mintTokens(budgetSats)

  const node = new SwarmNode()
  const topic = topicFromKind(kind)

  try {
    console.log(`[${tag}] Looking for kind ${kind} provider...`)
    await node.connect(topic)

    const peer = await node.waitForPeer(30_000)
    console.log(`[${tag}] Connected to provider: ${peer.peerId.slice(0, 12)}...`)

    // Channel: message handler pushes chunks, generator consumes them
    const chunks: string[] = []
    let finished = false
    let error: Error | null = null
    let notify: (() => void) | null = null

    function wake() {
      if (notify) { notify(); notify = null }
    }

    function waitForChunk(): Promise<void> {
      if (chunks.length > 0 || finished || error) return Promise.resolve()
      return new Promise<void>(r => { notify = r })
    }

    let microTokens: string[] = []
    let tokenIndex = 0

    function sendNextPayment() {
      if (tokenIndex >= microTokens.length) return false
      const token = microTokens[tokenIndex++]
      console.log(`[${tag}] Payment ${tokenIndex}/${microTokens.length}`)
      node.send(peer.socket, { type: 'payment', id: jobId, token })
      return true
    }

    // Timeout
    const timeout = setTimeout(() => {
      error = new Error(`P2P delegation timed out after 120s`)
      wake()
    }, 120_000)

    node.on('message', async (msg: SwarmMessage) => {
      if (msg.id !== jobId) return

      switch (msg.type) {
        case 'offer': {
          const spc = msg.sats_per_chunk ?? 0
          const cpp = msg.chunks_per_payment ?? 0
          const satsPerPayment = spc * cpp

          if (spc > MAX_SATS_PER_CHUNK) {
            node.send(peer.socket, { type: 'stop', id: jobId })
            error = new Error(`Price too high: ${spc} sat/chunk > max ${MAX_SATS_PER_CHUNK}`)
            wake()
            return
          }

          if (satsPerPayment <= 0) {
            error = new Error(`Invalid offer: sats_per_payment = 0`)
            wake()
            return
          }

          console.log(`[${tag}] Offer: ${spc} sat/chunk, ${cpp} chunks/payment`)
          try {
            microTokens = await splitTokens(bigToken, satsPerPayment)
            console.log(`[${tag}] Split into ${microTokens.length} micro-tokens`)
          } catch (e: any) {
            error = new Error(`Token split failed: ${e.message}`)
            wake()
            return
          }

          if (microTokens.length === 0) {
            error = new Error(`Budget too small for payment cycle`)
            wake()
            return
          }

          sendNextPayment()
          break
        }

        case 'payment_ack':
          break

        case 'accepted':
          console.log(`[${tag}] Accepted, streaming...`)
          break

        case 'chunk':
          if (msg.data) {
            chunks.push(msg.data)
            wake()
          }
          break

        case 'pay_required':
          if (!sendNextPayment()) {
            console.log(`[${tag}] Budget exhausted, sending stop`)
            node.send(peer.socket, { type: 'stop', id: jobId })
          }
          break

        case 'result':
          console.log(`[${tag}] Result: ${(msg.output || '').length} chars, ${msg.total_sats ?? '?'} sats`)
          finished = true
          wake()
          break

        case 'error':
          error = new Error(`Provider error: ${msg.message}`)
          wake()
          break
      }
    })

    // Send request
    node.send(peer.socket, {
      type: 'request',
      id: jobId,
      kind,
      input,
      budget: budgetSats,
    })

    // Yield chunks as they arrive
    while (true) {
      await waitForChunk()

      if (error) {
        clearTimeout(timeout)
        throw error
      }

      // Drain all available chunks
      while (chunks.length > 0) {
        yield chunks.shift()!
      }

      if (finished) {
        clearTimeout(timeout)
        return
      }
    }
  } finally {
    await node.destroy()
  }
}

/**
 * Streaming pipeline: delegates to a sub-provider via P2P, accumulates
 * chunks into batches, translates each batch locally via streaming Ollama,
 * and yields the translated tokens.
 *
 * Flow: sub-provider streams → batch → Ollama stream-translate → yield tokens
 */
async function* pipelineStream(kind: number, input: string, budgetSats: number): AsyncGenerator<string> {
  let batch = ''

  async function* translateBatch(text: string): AsyncGenerator<string> {
    for await (const token of state.processor!.generateStream(text)) {
      yield token
    }
  }

  for await (const chunk of delegateP2PStream(kind, input, budgetSats)) {
    batch += chunk

    // When batch is big enough, translate and stream out
    if (batch.length >= SUB_BATCH_SIZE) {
      yield* translateBatch(batch)
      batch = ''
    }
  }

  // Translate remaining text
  if (batch.length > 0) {
    yield* translateBatch(batch)
  }
}

/**
 * Delegate a sub-task via platform API. Creates a job, then polls until
 * the result is available (max 120s).
 */
async function delegateAPI(kind: number, input: string, bidSats: number, provider?: string): Promise<string> {
  const tag = `sub-api`

  const created = await createJob({ kind, input, bid_sats: bidSats, provider })
  if (!created) {
    throw new Error('Failed to create sub-task via API')
  }

  const jobId = created.job_id
  console.log(`[${tag}] Created job ${jobId} (kind ${kind}, bid ${bidSats})`)

  // Poll for result
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5_000))

    const job = await getJob(jobId)
    if (!job) continue

    if (job.status === 'completed' || job.status === 'result_available') {
      if (job.result) {
        console.log(`[${tag}] Job ${jobId}: got result (${job.result.length} chars)`)
        return job.result
      }
    }

    if (job.status === 'cancelled' || job.status === 'rejected') {
      throw new Error(`Sub-task ${jobId} was ${job.status}`)
    }
  }

  throw new Error(`Sub-task ${jobId} timed out after 120s`)
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

  // Pick the source: pipeline (delegate + local) or direct local generation
  const source = SUB_KIND
    ? pipelineStream(SUB_KIND, msg.input || '', SUB_BUDGET)
    : state.processor!.generateStream(msg.input || '')

  try {
    for await (const chunk of source) {
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
