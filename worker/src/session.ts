#!/usr/bin/env node
/**
 * P2P Session Client — "rent" a provider's service over Hyperswarm with
 * per-minute Cashu payments.
 *
 * Features:
 *   - Automatic per-minute micro-token billing via tick timer
 *   - HTTP proxy server for browser-based access to provider APIs
 *   - Interactive CLI REPL (generate, status, skill, help, quit)
 *
 * Usage:
 *   2020117-session --kind=5200 --budget=500 --port=8080
 *   npx 2020117-agent/session --kind=5200 --budget=500
 */

// --- CLI args -> env (before any imports) ---
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue
  const eq = arg.indexOf('=')
  if (eq === -1) continue
  const key = arg.slice(0, eq)
  const val = arg.slice(eq + 1)
  switch (key) {
    case '--kind':     process.env.DVM_KIND = val; break
    case '--budget':   process.env.BUDGET_SATS = val; break
    case '--port':     process.env.SESSION_PORT = val; break
    case '--agent':    process.env.AGENT = val; break
    case '--provider': process.env.PROVIDER_PEER = val; break
  }
}

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { queryProviderSkill } from './p2p-customer.js'
import { mintTokens, splitTokens } from './cashu.js'
import { randomBytes } from 'crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { createInterface } from 'readline'
import { mkdirSync, writeFileSync } from 'fs'

// --- Config ---

const KIND = Number(process.env.DVM_KIND) || 5200
const BUDGET = Number(process.env.BUDGET_SATS) || 500
const PORT = Number(process.env.SESSION_PORT) || 8080
const TICK_INTERVAL_MS = 60_000
const HTTP_TIMEOUT_MS = 60_000

// --- State ---

interface SessionClientState {
  node: SwarmNode | null
  socket: any
  peerId: string
  sessionId: string
  skill: Record<string, unknown> | null
  satsPerMinute: number
  microTokens: string[]
  tokenIndex: number
  totalSpent: number
  startedAt: number
  tickTimer: ReturnType<typeof setInterval> | null
  httpServer: ReturnType<typeof createServer> | null
  shuttingDown: boolean
  // Pending request/response maps keyed by message id
  pendingRequests: Map<string, { resolve: (msg: SwarmMessage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>
  outputCounter: number
}

const state: SessionClientState = {
  node: null,
  socket: null,
  peerId: '',
  sessionId: '',
  skill: null,
  satsPerMinute: 0,
  microTokens: [],
  tokenIndex: 0,
  totalSpent: 0,
  startedAt: 0,
  tickTimer: null,
  httpServer: null,
  shuttingDown: false,
  pendingRequests: new Map(),
  outputCounter: 0,
}

// --- Helpers ---

function log(msg: string) {
  console.log(`[session] ${msg}`)
}

function warn(msg: string) {
  console.warn(`[session] ${msg}`)
}

function elapsedSeconds(): number {
  return Math.round((Date.now() - state.startedAt) / 1000)
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}m${s.toString().padStart(2, '0')}s`
}

function remainingSats(): number {
  return BUDGET - state.totalSpent
}

function remainingTokens(): number {
  return state.microTokens.length - state.tokenIndex
}

function estimatedMinutesLeft(): number {
  if (state.satsPerMinute <= 0) return 0
  return Math.floor(remainingSats() / state.satsPerMinute)
}

/** Send a message and wait for a response with a matching id */
function sendAndWait(msg: SwarmMessage, timeoutMs: number): Promise<SwarmMessage> {
  return new Promise<SwarmMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingRequests.delete(msg.id)
      reject(new Error(`Timeout waiting for response to ${msg.type} (${timeoutMs}ms)`))
    }, timeoutMs)

    state.pendingRequests.set(msg.id, { resolve, reject, timer })
    state.node!.send(state.socket, msg)
  })
}

// --- 6. Message handler ---

function setupMessageHandler() {
  state.node!.on('message', (msg: SwarmMessage) => {
    // Check pending requests first — match by id
    const pending = state.pendingRequests.get(msg.id)
    if (pending) {
      clearTimeout(pending.timer)
      state.pendingRequests.delete(msg.id)

      if (msg.type === 'error') {
        pending.reject(new Error(msg.message || 'Provider error'))
      } else {
        pending.resolve(msg)
      }
      return
    }

    // Unsolicited messages from provider
    switch (msg.type) {
      case 'session_end': {
        // Provider ended the session
        log(`Provider ended session: ${msg.total_sats ?? '?'} sats, ${msg.duration_s ?? '?'}s`)
        cleanup()
        break
      }

      case 'session_tick_ack': {
        // Late tick ack that didn't match a pending request — just log it
        if (msg.balance !== undefined) {
          log(`Tick confirmed, provider reports balance: ${msg.balance} sats`)
        }
        break
      }

      case 'error': {
        warn(`Provider error: ${msg.message}`)
        break
      }

      default:
        // Unrecognized unsolicited message — ignore
        break
    }
  })

  // Handle provider disconnect
  state.node!.on('peer-leave', (peerId: string) => {
    if (peerId === state.peerId) {
      warn('Provider disconnected')
      cleanup()
    }
  })
}

// --- 3. Tick timer ---

function startTickTimer() {
  state.tickTimer = setInterval(async () => {
    if (state.shuttingDown) return

    if (remainingTokens() <= 0) {
      log('Budget exhausted — ending session')
      await endSession()
      return
    }

    // Low balance warning
    if (remainingTokens() <= 2) {
      warn(`Low balance! Only ${remainingTokens()} tick(s) remaining (${remainingSats()} sats)`)
    }

    const token = state.microTokens[state.tokenIndex++]
    state.totalSpent += state.satsPerMinute

    const tickId = randomBytes(4).toString('hex')
    try {
      const resp = await sendAndWait({
        type: 'session_tick',
        id: tickId,
        session_id: state.sessionId,
        token,
        budget: BUDGET,
      }, 15_000)

      if (resp.balance !== undefined) {
        log(`Tick OK — balance: ${resp.balance} sats`)
      }
    } catch (e: any) {
      warn(`Tick failed: ${e.message}`)
    }
  }, TICK_INTERVAL_MS)
}

// --- 4. HTTP proxy ---

function startHttpProxy(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!state.sessionId || state.shuttingDown) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Session not active' }))
        return
      }

      // Collect request body
      const bodyChunks: Buffer[] = []
      for await (const chunk of req) {
        bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      }
      const bodyStr = Buffer.concat(bodyChunks).toString()

      // Build headers map
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v
        else if (Array.isArray(v)) headers[k] = v.join(', ')
      }

      const reqId = randomBytes(4).toString('hex')

      try {
        const resp = await sendAndWait({
          type: 'http_request',
          id: reqId,
          session_id: state.sessionId,
          method: req.method || 'GET',
          path: req.url || '/',
          headers,
          body: bodyStr || undefined,
        }, HTTP_TIMEOUT_MS)

        // Forward response back to browser
        const respHeaders: Record<string, string> = { ...(resp.headers || {}) }
        // Remove hop-by-hop headers
        delete respHeaders['transfer-encoding']
        delete respHeaders['connection']

        res.writeHead(resp.status || 200, respHeaders)
        res.end(resp.body || '')
      } catch (e: any) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })

    server.on('error', (err: Error) => {
      if (!state.httpServer) {
        reject(err)
      } else {
        warn(`HTTP proxy error: ${err.message}`)
      }
    })

    server.listen(PORT, () => {
      state.httpServer = server
      resolve()
    })
  })
}

// --- 5. CLI REPL ---

function startRepl() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
  })

  rl.prompt()

  rl.on('line', async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) {
      rl.prompt()
      return
    }

    try {
      await handleCommand(trimmed)
    } catch (e: any) {
      warn(e.message)
    }

    if (!state.shuttingDown) {
      rl.prompt()
    }
  })

  rl.on('close', () => {
    endSession()
  })
}

async function handleCommand(line: string) {
  // Parse command and arguments
  const parts = parseCommandLine(line)
  const cmd = parts[0].toLowerCase()

  switch (cmd) {
    case 'generate': {
      await handleGenerate(parts.slice(1))
      break
    }
    case 'status': {
      handleStatus()
      break
    }
    case 'skill': {
      handleSkill()
      break
    }
    case 'help': {
      handleHelp()
      break
    }
    case 'quit':
    case 'exit': {
      await endSession()
      break
    }
    default: {
      warn(`Unknown command: ${cmd}. Type 'help' for available commands.`)
      break
    }
  }
}

/** Parse a command line preserving quoted strings and --key=val flags */
function parseCommandLine(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true
      quoteChar = ch
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return parts
}

async function handleGenerate(args: string[]) {
  // Extract prompt (non-flag args) and params (--key=val)
  const promptParts: string[] = []
  const params: Record<string, unknown> = {}

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        const k = arg.slice(2, eq)
        const v = arg.slice(eq + 1)
        // Try to parse as number
        const n = Number(v)
        params[k] = Number.isFinite(n) ? n : v
      }
    } else {
      promptParts.push(arg)
    }
  }

  const prompt = promptParts.join(' ')
  if (!prompt) {
    warn('Usage: generate "your prompt" --key=val')
    return
  }

  const reqId = randomBytes(4).toString('hex')
  const startTime = Date.now()

  log('Generating...')

  try {
    const resp = await sendAndWait({
      type: 'request',
      id: reqId,
      session_id: state.sessionId,
      kind: KIND,
      input: prompt,
      params: Object.keys(params).length > 0 ? params : undefined,
    }, 120_000)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    if (resp.output) {
      // Check if output looks like base64 image data (PNG/JPEG magic bytes in base64)
      if (isLikelyImageData(resp.output)) {
        const saved = saveImageFile(resp.output)
        log(`Saved: ${saved} (${elapsed}s)`)
      } else {
        log(`Result (${elapsed}s):`)
        console.log(resp.output)
      }
    } else {
      log(`Done (${elapsed}s, no output)`)
    }
  } catch (e: any) {
    warn(`Generate failed: ${e.message}`)
  }
}

function isLikelyImageData(data: string): boolean {
  // Base64-encoded PNG starts with iVBOR, JPEG with /9j/
  return data.startsWith('iVBOR') || data.startsWith('/9j/')
}

function saveImageFile(base64Data: string): string {
  mkdirSync('./output', { recursive: true })
  state.outputCounter++
  const ext = base64Data.startsWith('/9j/') ? 'jpg' : 'png'
  const filename = `./output/${String(state.outputCounter).padStart(3, '0')}.${ext}`
  const buf = Buffer.from(base64Data, 'base64')
  writeFileSync(filename, buf)
  return filename
}

function handleStatus() {
  const elapsed = elapsedSeconds()
  const spent = state.totalSpent
  const remaining = remainingSats()
  const estMin = estimatedMinutesLeft()
  log(`Connected: ${formatDuration(elapsed)} | Spent: ${spent} sats | Remaining: ${remaining} sats (~${estMin} min)`)
}

function handleSkill() {
  if (state.skill) {
    console.log(JSON.stringify(state.skill, null, 2))
  } else {
    log('No skill information available from provider')
  }
}

function handleHelp() {
  console.log(`
Commands:
  generate "prompt" --key=val   Send a generation request to the provider
  status                        Show elapsed time, spent sats, remaining balance
  skill                         Print provider skill manifest JSON
  help                          Show this help message
  quit / exit                   End session and disconnect
`)
}

// --- 7. Cleanup ---

async function endSession() {
  if (state.shuttingDown) return
  state.shuttingDown = true

  // Clear tick timer
  if (state.tickTimer) {
    clearInterval(state.tickTimer)
    state.tickTimer = null
  }

  // Cancel all pending requests
  for (const [id, pending] of state.pendingRequests) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Session ending'))
    state.pendingRequests.delete(id)
  }

  // Send session_end
  if (state.node && state.socket && state.sessionId) {
    const duration = elapsedSeconds()
    try {
      state.node.send(state.socket, {
        type: 'session_end',
        id: state.sessionId,
        session_id: state.sessionId,
        total_sats: state.totalSpent,
        duration_s: duration,
      })
    } catch {
      // socket may already be closed
    }
    log(`Session ended. Total: ${state.totalSpent} sats for ${duration}s.`)
  }

  // Close HTTP proxy
  if (state.httpServer) {
    state.httpServer.close()
    state.httpServer = null
  }

  // Destroy swarm
  if (state.node) {
    await state.node.destroy()
    state.node = null
  }

  process.exit(0)
}

function cleanup() {
  // Called from message handler when provider disconnects or ends session
  endSession()
}

// --- 2. Main flow ---

async function main() {
  log(`Connecting to kind ${KIND} provider (budget: ${BUDGET} sats)`)

  // 1. Connect to provider via Hyperswarm
  const node = new SwarmNode()
  state.node = node
  const topic = topicFromKind(KIND)

  await node.connect(topic)
  const { socket, peerId } = await node.waitForPeer(30_000)
  state.socket = socket
  state.peerId = peerId
  log(`Connected to provider: ${peerId.slice(0, 12)}...`)

  // Setup message handler before any messages
  setupMessageHandler()

  // 2. Query skill
  const skill = await queryProviderSkill(node, socket, KIND)
  state.skill = skill

  if (skill) {
    const name = skill.name || 'unknown'
    const version = skill.version || '?'
    const features = Array.isArray(skill.features) ? (skill.features as string[]).join(', ') : ''
    log(`Skill: ${name} v${version}${features ? ` (${features})` : ''}`)
  } else {
    log('Provider did not report a skill manifest')
  }

  // 3. Extract pricing — sats_per_minute from skill or fallback
  const pricing = skill?.pricing as Record<string, unknown> | undefined
  const satsPerMinute = Number(pricing?.sats_per_minute) || 10
  state.satsPerMinute = satsPerMinute

  log(`Pricing: ${satsPerMinute} sats/min`)
  log(`Budget: ${BUDGET} sats (~${Math.floor(BUDGET / satsPerMinute)} min)`)

  // 4. Mint and split tokens
  log(`Minting ${BUDGET} sats...`)
  const { token: bigToken } = await mintTokens(BUDGET)

  log(`Splitting into ${satsPerMinute}-sat micro-tokens...`)
  state.microTokens = await splitTokens(bigToken, satsPerMinute)
  log(`Ready: ${state.microTokens.length} micro-tokens`)

  if (state.microTokens.length === 0) {
    warn('Budget too small for even one tick payment')
    await node.destroy()
    process.exit(1)
  }

  // 5. Send session_start, wait for session_ack
  const startId = randomBytes(4).toString('hex')
  const ackResp = await sendAndWait({
    type: 'session_start',
    id: startId,
    budget: BUDGET,
    sats_per_minute: satsPerMinute,
  }, 15_000)

  if (ackResp.type !== 'session_ack' || !ackResp.session_id) {
    warn(`Unexpected response: ${ackResp.type}`)
    await node.destroy()
    process.exit(1)
  }

  state.sessionId = ackResp.session_id
  state.startedAt = Date.now()

  // If the provider dictated a different rate, use it
  if (ackResp.sats_per_minute && ackResp.sats_per_minute !== satsPerMinute) {
    state.satsPerMinute = ackResp.sats_per_minute
    log(`Provider adjusted rate: ${ackResp.sats_per_minute} sats/min`)
  }

  log(`Session started: ${state.sessionId}`)

  // 6. Start tick timer
  startTickTimer()

  // 7. Start HTTP proxy
  try {
    await startHttpProxy()
    log(`Web proxy ready at http://localhost:${PORT}`)
  } catch (e: any) {
    warn(`Failed to start HTTP proxy on port ${PORT}: ${e.message}`)
    warn('Continuing without HTTP proxy')
  }

  // 8. Show ready message and start REPL
  log("Type 'help' for commands")

  // SIGINT handler
  process.on('SIGINT', () => {
    endSession()
  })
  process.on('SIGTERM', () => {
    endSession()
  })

  startRepl()
}

// --- Entry point ---

main().catch(err => {
  console.error('[session] Fatal:', err.message || err)
  process.exit(1)
})
