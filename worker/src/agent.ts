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

// --- CLI args → env (for npx usage) ---
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue
  const eq = arg.indexOf('=')
  if (eq === -1) continue
  const key = arg.slice(0, eq)
  const val = arg.slice(eq + 1)
  switch (key) {
    case '--kind':         process.env.DVM_KIND = val; break
    case '--processor':    process.env.PROCESSOR = val; break
    case '--model':        process.env.OLLAMA_MODEL = val; break
    case '--agent':        process.env.AGENT = val; break
    case '--max-jobs':     process.env.MAX_JOBS = val; break
    case '--sub-kind':     process.env.SUB_KIND = val; break
    case '--sub-channel':  process.env.SUB_CHANNEL = val; break
    case '--sub-provider': process.env.SUB_PROVIDER = val; break
    case '--sub-bid':      process.env.SUB_BID = val; break
    case '--budget':       process.env.SUB_BUDGET = val; break
    case '--api-key':      process.env.API_2020117_KEY = val; break
    case '--api-url':      process.env.API_2020117_URL = val; break
    case '--models':       process.env.MODELS = val; break
    case '--skill':        process.env.SKILL_FILE = val; break
  }
}

import { randomBytes } from 'crypto'
import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { P2PJobState, waitForPayment, handlePayment, handleStop, streamToCustomer, batchClaim } from './p2p-provider.js'
import { streamFromProvider } from './p2p-customer.js'
import { createProcessor, Processor } from './processor.js'
import {
  hasApiKey, loadAgentName, registerService, startHeartbeatLoop,
  getInbox, acceptJob, sendFeedback, submitResult,
  createJob, getJob,
} from './api.js'
import { peekToken } from './cashu.js'
import { readFileSync } from 'fs'

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
const MIN_BID_SATS = Number(process.env.MIN_BID_SATS) || SATS_PER_CHUNK * CHUNKS_PER_PAYMENT  // default = pricing per job
const SUB_BATCH_SIZE = Number(process.env.SUB_BATCH_SIZE) || 500 // chars to accumulate before local processing

// --- Skill file loading ---

function loadSkill(): Record<string, unknown> | null {
  const skillPath = process.env.SKILL_FILE
  if (!skillPath) return null
  try {
    const raw = readFileSync(skillPath, 'utf-8')
    const skill = JSON.parse(raw)
    if (!skill.name || !skill.version || !Array.isArray(skill.features)) {
      console.error(`[agent] Skill file missing required fields: name, version, features`)
      process.exit(1)
    }
    return skill
  } catch (e: any) {
    console.error(`[agent] Failed to load skill file "${skillPath}": ${e.message}`)
    process.exit(1)
  }
}

// --- State ---

interface AgentState {
  agentName: string | null
  activeJobs: number
  shuttingDown: boolean
  stopHeartbeat: (() => void) | null
  pollTimer: ReturnType<typeof setTimeout> | null
  swarmNode: SwarmNode | null
  processor: Processor | null
  skill: Record<string, unknown> | null
}

const state: AgentState = {
  agentName: loadAgentName(),
  activeJobs: 0,
  shuttingDown: false,
  stopHeartbeat: null,
  pollTimer: null,
  swarmNode: null,
  processor: null,
  skill: loadSkill(),
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

  if (state.skill) {
    console.log(`[${label}] Skill: ${state.skill.name} v${state.skill.version} (${(state.skill.features as string[]).join(', ')})`)
  }

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
  const models = process.env.MODELS ? process.env.MODELS.split(',').map(s => s.trim()) : undefined
  await registerService({
    kind: KIND,
    satsPerChunk: SATS_PER_CHUNK,
    chunksPerPayment: CHUNKS_PER_PAYMENT,
    model: state.processor?.name || 'unknown',
    models,
    skill: state.skill,
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

        // Check bid meets minimum pricing
        const bidSats = job.bid_sats ?? 0
        if (MIN_BID_SATS > 0 && bidSats < MIN_BID_SATS) {
          console.log(`[${label}] Skipping job ${job.id}: bid ${bidSats} < min ${MIN_BID_SATS} sats`)
          releaseSlot()
          continue
        }

        // Process in background — don't await
        processAsyncJob(label, job.id, job.input, job.params).catch((err) => {
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

async function processAsyncJob(label: string, inboxJobId: string, input: string, params?: Record<string, unknown>) {
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
          result = await state.processor!.generate({ input: subResult, params })
        } else {
          // P2P delegation — stream-collect from sub-provider, batch-translate
          result = ''
          for await (const chunk of pipelineStream(SUB_KIND, input, SUB_BUDGET)) {
            result += chunk
          }
        }
      } catch (e: any) {
        console.error(`[${label}] Job ${providerJobId}: sub-task failed: ${e.message}, using original input`)
        result = await state.processor!.generate({ input, params })
      }
    } else {
      // No pipeline — direct local processing
      result = await state.processor!.generate({ input, params })
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
 * Thin wrapper around the shared streamFromProvider() module.
 */
async function* delegateP2PStream(kind: number, input: string, budgetSats: number): AsyncGenerator<string> {
  yield* streamFromProvider({
    kind,
    input,
    budgetSats,
    maxSatsPerChunk: MAX_SATS_PER_CHUNK,
    label: 'sub-p2p',
  })
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
    for await (const token of state.processor!.generateStream({ input: text })) {
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

const p2pJobs = new Map<string, P2PJobState>()

// --- Session state ---

interface SessionState {
  socket: any
  peerId: string
  sessionId: string
  satsPerMinute: number
  tokens: string[]
  totalEarned: number
  startedAt: number
  lastTickAt: number
  timeoutTimer: ReturnType<typeof setInterval> | null
}

const activeSessions = new Map<string, SessionState>()

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

    if (msg.type === 'skill_request') {
      node.send(socket, { type: 'skill_response', id: msg.id, skill: state.skill })
      return
    }

    // --- Session protocol ---

    if (msg.type === 'session_start') {
      const satsPerMinute =
        (state.skill?.pricing as any)?.sats_per_minute
        || Number(process.env.SATS_PER_MINUTE)
        || msg.sats_per_minute
        || 10

      const sessionId = randomBytes(8).toString('hex')
      console.log(`[${label}] Session ${sessionId} from ${tag}: ${satsPerMinute} sats/min`)

      const session: SessionState = {
        socket,
        peerId,
        sessionId,
        satsPerMinute,
        tokens: [],
        totalEarned: 0,
        startedAt: Date.now(),
        lastTickAt: Date.now(),
        timeoutTimer: null,
      }

      // Timeout checker — if no tick for 2 minutes, end session
      session.timeoutTimer = setInterval(() => {
        const elapsed = Date.now() - session.lastTickAt
        if (elapsed > 120_000) {
          console.log(`[${label}] Session ${sessionId}: timeout (no tick for 2 min)`)
          endSession(node, session, label)
        }
      }, 30_000)

      activeSessions.set(sessionId, session)

      node.send(socket, {
        type: 'session_ack',
        id: msg.id,
        session_id: sessionId,
        sats_per_minute: satsPerMinute,
      })
      return
    }

    if (msg.type === 'session_tick') {
      const session = activeSessions.get(msg.session_id || '')
      if (!session) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Unknown session' })
        return
      }

      if (!msg.token) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Tick missing token' })
        return
      }

      try {
        const peek = peekToken(msg.token)
        session.tokens.push(msg.token)
        session.totalEarned += peek.amount
        session.lastTickAt = Date.now()

        console.log(`[${label}] Session ${session.sessionId}: tick ${peek.amount} sats (total: ${session.totalEarned})`)
        node.send(socket, {
          type: 'session_tick_ack',
          id: msg.id,
          session_id: session.sessionId,
          balance: msg.budget ? msg.budget - session.totalEarned : undefined,
        })
      } catch (e: any) {
        node.send(socket, { type: 'error', id: msg.id, message: `Tick payment failed: ${e.message}` })
      }
      return
    }

    if (msg.type === 'session_end') {
      const session = activeSessions.get(msg.session_id || '')
      if (!session) return
      endSession(node, session, label)
      return
    }

    if (msg.type === 'http_request') {
      const session = findSessionBySocket(socket)
      if (!session) {
        node.send(socket, { type: 'error', id: msg.id, message: 'No active session' })
        return
      }

      const processorUrl = process.env.PROCESSOR
      if (!processorUrl || (!processorUrl.startsWith('http://') && !processorUrl.startsWith('https://'))) {
        node.send(socket, {
          type: 'http_response',
          id: msg.id,
          status: 502,
          body: JSON.stringify({ error: 'Provider has no HTTP backend configured' }),
        })
        return
      }

      try {
        const targetUrl = new URL(msg.path || '/', processorUrl).toString()
        const fetchHeaders: Record<string, string> = { ...(msg.headers || {}) }
        delete fetchHeaders['host']

        const res = await fetch(targetUrl, {
          method: msg.method || 'GET',
          headers: fetchHeaders,
          body: msg.method !== 'GET' && msg.method !== 'HEAD' ? msg.body : undefined,
        })

        const resBody = await res.text()
        const resHeaders: Record<string, string> = {}
        res.headers.forEach((v, k) => { resHeaders[k] = v })

        node.send(socket, {
          type: 'http_response',
          id: msg.id,
          status: res.status,
          headers: resHeaders,
          body: resBody,
        })
      } catch (e: any) {
        node.send(socket, {
          type: 'http_response',
          id: msg.id,
          status: 502,
          body: JSON.stringify({ error: e.message }),
        })
      }
      return
    }

    // Session-scoped request (no payment negotiation — session pays per-minute)
    if (msg.type === 'request' && msg.session_id) {
      const session = activeSessions.get(msg.session_id)
      if (!session) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Unknown session' })
        return
      }
      console.log(`[${label}] Session job ${msg.id}: "${(msg.input || '').slice(0, 60)}..."`)
      try {
        const result = await state.processor!.generate({ input: msg.input || '', params: msg.params })
        node.send(socket, { type: 'result', id: msg.id, output: result })
        console.log(`[${label}] Session job ${msg.id}: ${result.length} chars`)
      } catch (e: any) {
        node.send(socket, { type: 'error', id: msg.id, message: e.message })
      }
      return
    }

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
      const paid = await waitForPayment(job, msg.id, node, label, PAYMENT_TIMEOUT)
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
      if (job) handlePayment(node, socket, msg, job, SATS_PER_CHUNK, label)
    }

    if (msg.type === 'stop') {
      const job = p2pJobs.get(msg.id)
      if (job) handleStop(job, msg.id, label)
    }
  })
}

async function runP2PGeneration(node: SwarmNode, job: P2PJobState, msg: SwarmMessage, label: string) {
  const source = SUB_KIND
    ? pipelineStream(SUB_KIND, msg.input || '', SUB_BUDGET)
    : state.processor!.generateStream({ input: msg.input || '', params: msg.params })

  await streamToCustomer({
    node,
    job,
    jobId: msg.id,
    source,
    satsPerChunk: SATS_PER_CHUNK,
    chunksPerPayment: CHUNKS_PER_PAYMENT,
    timeoutMs: PAYMENT_TIMEOUT,
    label,
  })

  await batchClaim(job.tokens, msg.id, label)
  p2pJobs.delete(msg.id)
  releaseSlot()
}

// --- Session helpers ---

function findSessionBySocket(socket: any): SessionState | undefined {
  for (const session of activeSessions.values()) {
    if (session.socket === socket) return session
  }
  return undefined
}

function endSession(node: SwarmNode, session: SessionState, label: string) {
  const durationS = Math.round((Date.now() - session.startedAt) / 1000)

  if (session.timeoutTimer) {
    clearInterval(session.timeoutTimer)
    session.timeoutTimer = null
  }

  node.send(session.socket, {
    type: 'session_end',
    id: session.sessionId,
    session_id: session.sessionId,
    total_sats: session.totalEarned,
    duration_s: durationS,
  })

  console.log(`[${label}] Session ${session.sessionId} ended: ${session.totalEarned} sats, ${durationS}s`)

  // Batch claim tokens
  batchClaim(session.tokens, session.sessionId, label)
  activeSessions.delete(session.sessionId)
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
