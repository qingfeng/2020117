#!/usr/bin/env node
/**
 * Unified Agent Runtime — runs as a long-lived daemon that handles:
 *   1. Async platform tasks (inbox polling → accept → process → submit result)
 *   2. P2P sessions (Hyperswarm + CLINK per-minute billing)
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
    case '--sub-provider': process.env.SUB_PROVIDER = val; break
    case '--sub-bid':      process.env.SUB_BID = val; break
    case '--api-key':      process.env.API_2020117_KEY = val; break
    case '--api-url':      process.env.API_2020117_URL = val; break
    case '--models':       process.env.MODELS = val; break
    case '--skill':        process.env.SKILL_FILE = val; break
    case '--lightning-address': process.env.LIGHTNING_ADDRESS = val; break
  }
}

import { randomBytes } from 'crypto'
import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { createProcessor, Processor } from './processor.js'
import {
  hasApiKey, loadAgentName, registerService, startHeartbeatLoop,
  getInbox, acceptJob, sendFeedback, submitResult,
  createJob, getJob, getProfile, reportSession,
} from './api.js'
import { initClinkAgent, collectPayment } from './clink.js'
import { readFileSync } from 'fs'
import WebSocket from 'ws'
// Polyfill global WebSocket for Node.js < 22 (needed by @shocknet/clink-sdk)
if (!globalThis.WebSocket) (globalThis as any).WebSocket = WebSocket

// --- Config from env ---

const KIND = Number(process.env.DVM_KIND) || 5100
const MAX_CONCURRENT = Number(process.env.MAX_JOBS) || 3
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL) || 30_000
const SATS_PER_CHUNK = Number(process.env.SATS_PER_CHUNK) || 1
const CHUNKS_PER_PAYMENT = Number(process.env.CHUNKS_PER_PAYMENT) || 10

// --- CLINK payment config ---
let LIGHTNING_ADDRESS = process.env.LIGHTNING_ADDRESS || ''

// --- Sub-task delegation config ---
const SUB_KIND = process.env.SUB_KIND ? Number(process.env.SUB_KIND) : null
const SUB_PROVIDER = process.env.SUB_PROVIDER || undefined
const SUB_BID = Number(process.env.SUB_BID) || 100
const MIN_BID_SATS = Number(process.env.MIN_BID_SATS) || SATS_PER_CHUNK * CHUNKS_PER_PAYMENT  // default = pricing per job

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
  // P2P session lifetime counters (in-memory, resets on restart)
  p2pSessionsCompleted: number
  p2pTotalEarnedSats: number
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
  p2pSessionsCompleted: 0,
  p2pTotalEarnedSats: 0,
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
    console.log(`[${label}] Pipeline: sub-task kind=${SUB_KIND} (bid=${SUB_BID}${SUB_PROVIDER ? `, provider=${SUB_PROVIDER}` : ''})`)
  } else if (state.processor.name === 'none') {
    console.warn(`[${label}] WARNING: processor=none without SUB_KIND — generate() will pass through input as-is`)
  }
  await state.processor.verify()
  console.log(`[${label}] Processor "${state.processor.name}" verified`)

  if (state.skill) {
    console.log(`[${label}] Skill: ${state.skill.name} v${state.skill.version} (${(state.skill.features as string[]).join(', ')})`)
  }

  // 2. Auto-fetch Lightning Address from platform if not set via CLI/env
  if (!LIGHTNING_ADDRESS && hasApiKey()) {
    const profile = await getProfile()
    if (profile?.lightning_address) {
      LIGHTNING_ADDRESS = profile.lightning_address
      console.log(`[${label}] Lightning Address loaded from platform: ${LIGHTNING_ADDRESS}`)
    }
  }

  // 3. Initialize CLINK agent identity (for P2P session debit)
  if (LIGHTNING_ADDRESS) {
    const { pubkey } = initClinkAgent()
    console.log(`[${label}] CLINK: ${LIGHTNING_ADDRESS} (agent pubkey: ${pubkey.slice(0, 16)}...)`)
  }

  // 4. Platform registration + heartbeat
  await setupPlatform(label)

  // 5. Async inbox poller
  startInboxPoller(label)

  // 6. P2P swarm listener
  await startSwarmListener(label)

  // 6. Graceful shutdown
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
  state.stopHeartbeat = startHeartbeatLoop(() => getAvailableCapacity(), () => ({
    sessions: state.p2pSessionsCompleted,
    earned_sats: state.p2pTotalEarnedSats,
    active: activeSessions.size > 0,
  }))
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

    // Pipeline: delegate sub-task via API then process locally
    if (SUB_KIND) {
      console.log(`[${label}] Job ${providerJobId}: delegating to kind ${SUB_KIND}...`)
      try {
        const subResult = await delegateAPI(SUB_KIND, input, SUB_BID, SUB_PROVIDER)
        console.log(`[${label}] Job ${providerJobId}: sub-task returned ${subResult.length} chars`)
        result = await state.processor!.generate({ input: subResult, params })
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

// --- Session state ---

interface SessionState {
  socket: any
  peerId: string
  sessionId: string
  satsPerMinute: number
  ndebit: string             // customer's ndebit1... authorization
  totalEarned: number
  startedAt: number
  lastDebitAt: number
  debitTimer: ReturnType<typeof setInterval> | null
  timeoutTimer: ReturnType<typeof setTimeout> | null
}

const activeSessions = new Map<string, SessionState>()

// Backend WebSocket connections for WS tunnel (keyed by ws_id)
const backendWebSockets = new Map<string, { ws: WebSocket; peerId: string }>()

async function startSwarmListener(label: string) {
  const node = new SwarmNode()
  state.swarmNode = node

  const topic = topicFromKind(KIND)

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
      if (!LIGHTNING_ADDRESS) {
        console.warn(`[${label}] Session rejected: no --lightning-address configured`)
        node.send(socket, { type: 'error', id: msg.id, message: 'Provider has no Lightning Address configured' })
        return
      }

      if (!msg.ndebit) {
        node.send(socket, { type: 'error', id: msg.id, message: 'session_start requires ndebit authorization' })
        return
      }

      const satsPerMinute =
        (state.skill?.pricing as any)?.sats_per_minute
        || Number(process.env.SATS_PER_MINUTE)
        || msg.sats_per_minute
        || 10

      const BILLING_INTERVAL_MIN = 10
      const debitAmount = satsPerMinute * BILLING_INTERVAL_MIN

      const sessionId = randomBytes(8).toString('hex')
      console.log(`[${label}] Session ${sessionId} from ${tag}: ${satsPerMinute} sats/min, billing every ${BILLING_INTERVAL_MIN}min (${debitAmount} sats)`)

      const session: SessionState = {
        socket,
        peerId,
        sessionId,
        satsPerMinute,
        ndebit: msg.ndebit,
        totalEarned: 0,
        startedAt: Date.now(),
        lastDebitAt: Date.now(),
        debitTimer: null,
        timeoutTimer: null,
      }

      activeSessions.set(sessionId, session)

      // Debit first 10 minutes immediately (prepaid model)
      const firstDebit = await collectPayment({
        ndebit: session.ndebit,
        lightningAddress: LIGHTNING_ADDRESS,
        amountSats: debitAmount,
      })

      if (!firstDebit.ok) {
        console.warn(`[${label}] Session ${sessionId}: first debit failed: ${firstDebit.error}`)
        node.send(socket, { type: 'error', id: msg.id, message: `Payment failed: ${firstDebit.error}` })
        activeSessions.delete(sessionId)
        return
      }

      session.totalEarned += debitAmount
      session.lastDebitAt = Date.now()
      console.log(`[${label}] Session ${sessionId}: first ${BILLING_INTERVAL_MIN}min paid (${debitAmount} sats)`)

      node.send(socket, {
        type: 'session_ack',
        id: msg.id,
        session_id: sessionId,
        sats_per_minute: satsPerMinute,
      })

      // Notify customer of the debit
      node.send(socket, {
        type: 'session_tick_ack',
        id: sessionId,
        session_id: sessionId,
        amount: debitAmount,
        balance: msg.budget ? msg.budget - session.totalEarned : undefined,
      })

      // Debit every 10 minutes
      session.debitTimer = setInterval(async () => {
        const debit = await collectPayment({
          ndebit: session.ndebit,
          lightningAddress: LIGHTNING_ADDRESS,
          amountSats: debitAmount,
        })

        if (!debit.ok) {
          console.log(`[${label}] Session ${sessionId}: debit failed (${debit.error}) — ending session`)
          endSession(node, session, label)
          return
        }

        session.totalEarned += debitAmount
        session.lastDebitAt = Date.now()
        console.log(`[${label}] Session ${sessionId}: debit OK (+${debitAmount}, total: ${session.totalEarned} sats)`)

        // Notify customer
        node.send(socket, {
          type: 'session_tick_ack',
          id: sessionId,
          session_id: sessionId,
          amount: debitAmount,
          balance: msg.budget ? msg.budget - session.totalEarned : undefined,
        })
      }, BILLING_INTERVAL_MIN * 60_000)

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

        const resHeaders: Record<string, string> = {}
        res.headers.forEach((v, k) => { resHeaders[k] = v })

        // Detect binary content — read as ArrayBuffer to avoid text() mangling
        const ct = (res.headers.get('content-type') || '').toLowerCase()
        const isText = ct.startsWith('text/') || ct.includes('json') || ct.includes('javascript')
          || ct.includes('xml') || ct.includes('svg') || ct.includes('css')
          || ct.includes('html') || ct === ''
        const bodyEncoding: 'base64' | undefined = isText ? undefined : 'base64'

        let resBody: string
        if (isText) {
          resBody = await res.text()
        } else {
          const buf = Buffer.from(await res.arrayBuffer())
          resBody = buf.toString('base64')
        }

        // Chunk large responses to avoid swarm transport truncation
        const CHUNK_SIZE = 48_000 // ~48KB per chunk (safe margin under 64KB NOISE frame)
        if (resBody.length > CHUNK_SIZE) {
          const chunks: string[] = []
          for (let i = 0; i < resBody.length; i += CHUNK_SIZE) {
            chunks.push(resBody.slice(i, i + CHUNK_SIZE))
          }
          for (let i = 0; i < chunks.length; i++) {
            node.send(socket, {
              type: 'http_response',
              id: msg.id,
              status: i === 0 ? res.status : undefined,
              headers: i === 0 ? resHeaders : undefined,
              body: chunks[i],
              body_encoding: i === 0 ? bodyEncoding : undefined,
              chunk_index: i,
              chunk_total: chunks.length,
            })
          }
        } else {
          node.send(socket, {
            type: 'http_response',
            id: msg.id,
            status: res.status,
            headers: resHeaders,
            body: resBody,
            body_encoding: bodyEncoding,
          })
        }
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

    // --- WebSocket tunnel ---

    if (msg.type === 'ws_open') {
      const session = findSessionBySocket(socket)
      if (!session) {
        node.send(socket, { type: 'error', id: msg.id, message: 'No active session' })
        return
      }

      const processorUrl = process.env.PROCESSOR
      if (!processorUrl || (!processorUrl.startsWith('http://') && !processorUrl.startsWith('https://'))) {
        node.send(socket, { type: 'ws_open', id: msg.id, ws_id: msg.ws_id, message: 'No HTTP backend configured' })
        return
      }

      const wsId = msg.ws_id!
      const wsPath = msg.ws_path || '/'
      const backendWsUrl = processorUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '') + wsPath

      console.log(`[${label}] WS ${wsId}: opening ${backendWsUrl}`)

      try {
        const backendWs = new WebSocket(backendWsUrl, msg.ws_protocols || [])
        backendWebSockets.set(wsId, { ws: backendWs, peerId })

        backendWs.on('open', () => {
          console.log(`[${label}] WS ${wsId}: backend connected`)
        })

        backendWs.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          if (isBinary) {
            node.send(socket, { type: 'ws_message', id: wsId, ws_id: wsId, data: buf.toString('base64'), ws_frame_type: 'binary' })
          } else {
            node.send(socket, { type: 'ws_message', id: wsId, ws_id: wsId, data: buf.toString('utf-8'), ws_frame_type: 'text' })
          }
        })

        backendWs.on('close', (code: number, reason: Buffer) => {
          console.log(`[${label}] WS ${wsId}: backend closed (code=${code})`)
          backendWebSockets.delete(wsId)
          node.send(socket, { type: 'ws_close', id: wsId, ws_id: wsId, ws_code: code, ws_reason: reason.toString() })
        })

        backendWs.on('error', (err: Error) => {
          console.error(`[${label}] WS ${wsId}: backend error: ${err.message}`)
          backendWebSockets.delete(wsId)
          node.send(socket, { type: 'ws_close', id: wsId, ws_id: wsId, ws_code: 1011, ws_reason: 'Backend WebSocket error' })
        })
      } catch (e: any) {
        node.send(socket, { type: 'ws_open', id: msg.id, ws_id: wsId, message: e.message })
      }
      return
    }

    if (msg.type === 'ws_message') {
      const entry = backendWebSockets.get(msg.ws_id || '')
      if (!entry || entry.ws.readyState !== WebSocket.OPEN) return
      try {
        if (msg.ws_frame_type === 'binary') {
          entry.ws.send(Buffer.from(msg.data || '', 'base64'))
        } else {
          entry.ws.send(msg.data || '')
        }
      } catch (e: any) {
        console.error(`[${label}] WS ${msg.ws_id}: send failed: ${e.message}`)
      }
      return
    }

    if (msg.type === 'ws_close') {
      const entry = backendWebSockets.get(msg.ws_id || '')
      if (entry) {
        console.log(`[${label}] WS ${msg.ws_id}: closing backend`)
        try { entry.ws.close(msg.ws_code || 1000, msg.ws_reason || '') } catch {}
        backendWebSockets.delete(msg.ws_id || '')
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

  })

  // Handle customer disconnect — payments already settled via CLINK
  node.on('peer-leave', (peerId: string) => {
    const tag = peerId.slice(0, 8)

    // Find and end all sessions for this peer
    for (const [sessionId, session] of activeSessions) {
      if (session.peerId === peerId) {
        console.log(`[${label}] Peer ${tag} disconnected — ending session ${sessionId} (${session.totalEarned} sats earned)`)
        endSession(node, session, label)
      }
    }

    // Clean up backend WebSockets for this peer
    for (const [wsId, entry] of backendWebSockets) {
      if (entry.peerId === peerId) {
        try { entry.ws.close(1001, 'Peer disconnected') } catch {}
        backendWebSockets.delete(wsId)
      }
    }
  })
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

  // Stop debit timer
  if (session.debitTimer) {
    clearInterval(session.debitTimer)
    session.debitTimer = null
  }

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer)
    session.timeoutTimer = null
  }

  // Close all backend WebSockets for this peer
  for (const [wsId, entry] of backendWebSockets) {
    if (entry.peerId === session.peerId) {
      try { entry.ws.close(1001, 'Session ended') } catch {}
      backendWebSockets.delete(wsId)
    }
  }

  try {
    node.send(session.socket, {
      type: 'session_end',
      id: session.sessionId,
      session_id: session.sessionId,
      total_sats: session.totalEarned,
      duration_s: durationS,
    })
  } catch {
    // Socket may already be closed (peer disconnect)
  }

  console.log(`[${label}] Session ${session.sessionId} ended: ${session.totalEarned} sats, ${durationS}s`)

  // Update P2P lifetime counters — no batch claim needed with CLINK (payments settled instantly)
  state.p2pSessionsCompleted++
  state.p2pTotalEarnedSats += session.totalEarned

  // Report session to platform activity feed (best-effort, no content exposed)
  if (hasApiKey()) {
    reportSession({ kind: KIND, durationS, totalSats: session.totalEarned })
  }

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
