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
    case '--mint':     process.env.CASHU_MINT_URL = val; break
  }
}

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { queryProviderSkill } from './p2p-customer.js'
import { mintTokens, splitTokens, createWallet } from './cashu.js'
import { randomBytes } from 'crypto'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { createInterface } from 'readline'
import { mkdirSync, writeFileSync } from 'fs'
import { Socket } from 'net'
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws'

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
  satsPerToken: number
  tickIntervalMs: number
  microTokens: string[]
  tokenIndex: number
  totalSpent: number
  startedAt: number
  tickTimer: ReturnType<typeof setInterval> | null
  httpServer: ReturnType<typeof createServer> | null
  shuttingDown: boolean
  // Pending request/response maps keyed by message id
  pendingRequests: Map<string, { resolve: (msg: SwarmMessage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>
  // Chunked response reassembly buffers keyed by message id
  chunkBuffers: Map<string, { chunks: (string | undefined)[]; total: number; firstMsg: SwarmMessage }>
  // Active WebSocket tunnels: ws_id -> ws WebSocket from browser upgrade
  activeWebSockets: Map<string, WsWebSocket>
  outputCounter: number
}

const state: SessionClientState = {
  node: null,
  socket: null,
  peerId: '',
  sessionId: '',
  skill: null,
  satsPerMinute: 0,
  satsPerToken: 1,
  tickIntervalMs: 60_000,
  microTokens: [],
  tokenIndex: 0,
  totalSpent: 0,
  startedAt: 0,
  tickTimer: null,
  httpServer: null,
  shuttingDown: false,
  pendingRequests: new Map(),
  chunkBuffers: new Map(),
  activeWebSockets: new Map(),
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
    // Handle chunked HTTP responses — reassemble before resolving
    if (msg.type === 'http_response' && msg.chunk_total && msg.chunk_total > 1) {
      const id = msg.id
      let buf = state.chunkBuffers.get(id)
      if (!buf) {
        buf = { chunks: new Array(msg.chunk_total), total: msg.chunk_total, firstMsg: msg }
        state.chunkBuffers.set(id, buf)
      }
      buf.chunks[msg.chunk_index ?? 0] = msg.body ?? ''

      const received = buf.chunks.filter(c => c !== undefined).length
      if (received < buf.total) return // wait for more chunks

      // All chunks received — reassemble and resolve
      const assembled: SwarmMessage = {
        ...buf.firstMsg,
        body: buf.chunks.join(''),
        chunk_index: undefined,
        chunk_total: undefined,
      }
      state.chunkBuffers.delete(id)

      const pending = state.pendingRequests.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        state.pendingRequests.delete(id)
        pending.resolve(assembled)
      }
      return
    }

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

      case 'ws_message': {
        const browserWs = state.activeWebSockets.get(msg.ws_id || '')
        if (!browserWs || browserWs.readyState !== WsWebSocket.OPEN) {
          state.activeWebSockets.delete(msg.ws_id || '')
          break
        }
        try {
          if (msg.ws_frame_type === 'binary') {
            browserWs.send(Buffer.from(msg.data || '', 'base64'))
          } else {
            browserWs.send(msg.data || '')
          }
        } catch {}
        break
      }

      case 'ws_close': {
        const browserWs = state.activeWebSockets.get(msg.ws_id || '')
        if (browserWs && browserWs.readyState === WsWebSocket.OPEN) {
          browserWs.close(msg.ws_code || 1000, msg.ws_reason || '')
        }
        state.activeWebSockets.delete(msg.ws_id || '')
        log(`WS ${msg.ws_id}: closed by provider (code=${msg.ws_code || 1000})`)
        break
      }

      case 'ws_open': {
        // Provider failed to open backend WS
        if (msg.message) {
          const browserWs = state.activeWebSockets.get(msg.ws_id || '')
          if (browserWs && browserWs.readyState === WsWebSocket.OPEN) {
            browserWs.close(1011, msg.message)
          }
          state.activeWebSockets.delete(msg.ws_id || '')
          warn(`WS ${msg.ws_id}: provider failed: ${msg.message}`)
        }
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

async function sendTick(): Promise<boolean> {
  if (state.shuttingDown) return false

  if (remainingTokens() <= 0) {
    log('Budget exhausted — ending session')
    await endSession()
    return false
  }

  if (remainingTokens() <= 2) {
    warn(`Low balance! Only ${remainingTokens()} tick(s) remaining (${remainingSats()} sats)`)
  }

  const token = state.microTokens[state.tokenIndex++]
  state.totalSpent += state.satsPerToken

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
    return true
  } catch (e: any) {
    warn(`Tick failed: ${e.message}`)
    return false
  }
}

function startTickTimer() {
  // Send first tick immediately (prepay) to prevent provider timeout
  sendTick()
  state.tickTimer = setInterval(() => sendTick(), state.tickIntervalMs)
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
        // Remove hop-by-hop and size headers (body may differ after P2P relay)
        delete respHeaders['transfer-encoding']
        delete respHeaders['connection']
        delete respHeaders['content-length']
        delete respHeaders['content-encoding']

        res.writeHead(resp.status || 200, respHeaders)
        res.end(resp.body || '')
      } catch (e: any) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })

    // Enable WebSocket tunneling on the same server
    setupWebSocketProxy(server)

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

// --- 4b. WebSocket tunnel (via ws library) ---

function setupWebSocketProxy(server: ReturnType<typeof createServer>) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!state.sessionId || state.shuttingDown) {
      socket.destroy()
      return
    }

    const wsId = randomBytes(4).toString('hex')
    const path = req.url || '/'
    const protocols = req.headers['sec-websocket-protocol']
      ? req.headers['sec-websocket-protocol'].split(',').map(s => s.trim())
      : undefined

    log(`WS ${wsId}: upgrade ${path}`)

    wss.handleUpgrade(req, socket, head, (ws) => {
      state.activeWebSockets.set(wsId, ws)

      // Tell provider to open backend WS
      state.node!.send(state.socket, {
        type: 'ws_open',
        id: wsId,
        ws_id: wsId,
        session_id: state.sessionId,
        ws_path: path,
        ws_protocols: protocols,
      })

      // Browser → provider
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        state.node!.send(state.socket, {
          type: 'ws_message',
          id: wsId,
          ws_id: wsId,
          data: isBinary ? buf.toString('base64') : buf.toString('utf-8'),
          ws_frame_type: isBinary ? 'binary' : 'text',
        })
      })

      ws.on('close', (code: number, reason: Buffer) => {
        if (state.activeWebSockets.has(wsId)) {
          state.activeWebSockets.delete(wsId)
          try {
            state.node!.send(state.socket, {
              type: 'ws_close',
              id: wsId,
              ws_id: wsId,
              ws_code: code,
              ws_reason: reason.toString('utf-8'),
            })
          } catch {}
        }
      })

      ws.on('error', () => { state.activeWebSockets.delete(wsId) })
    })
  })
}

// --- 5. CLI REPL ---

function startRepl() {
  // Skip REPL when stdin is not a TTY (e.g. background process, piped input)
  if (!process.stdin.isTTY) {
    log('Non-interactive mode (no TTY) — session will run until budget exhausted or provider ends it')
    return
  }

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
  state.chunkBuffers.clear()

  // Close all WebSocket tunnels
  for (const [wsId, ws] of state.activeWebSockets) {
    try { ws.close(1001, 'Session ending') } catch {}
  }
  state.activeWebSockets.clear()

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
  // Cashu tokens must be whole sats. If rate < 1, use 1 sat tokens with longer tick intervals.
  const satsPerToken = Math.max(1, Math.ceil(satsPerMinute))
  const tickMinutes = satsPerToken / satsPerMinute  // e.g. 0.1 sats/min → 1 sat every 10 min
  state.tickIntervalMs = Math.round(tickMinutes * 60_000)
  state.satsPerToken = satsPerToken

  // Check mint fees — each micro-token must cover satsPerToken + swap fee (so provider
  // can claim it), and each wallet.send during splitting also costs a fee.
  const mintUrl = process.env.CASHU_MINT_URL || 'https://nofee.testnut.cashu.space'
  const { wallet: tmpWallet } = createWallet(mintUrl)
  await tmpWallet.loadMint()
  const swapFee = tmpWallet.getFeesForKeyset(1, tmpWallet.keysetId)
  const tokenAmount = satsPerToken + swapFee   // what each micro-token contains
  const numTokens = Math.ceil(BUDGET / satsPerToken)
  // Each split (wallet.send) also costs a fee, plus proof fragmentation overhead
  const splitOverhead = swapFee > 0 ? Math.ceil(swapFee * 1.5) : 0
  const totalNeeded = (tokenAmount + splitOverhead) * numTokens
  const mintAmount = Math.max(BUDGET, totalNeeded)

  if (swapFee > 0) {
    log(`Mint swap fee: ${swapFee} sats/token → minting ${tokenAmount} sats/token (${satsPerToken} + ${swapFee} fee)`)
    if (mintAmount > BUDGET * 3) {
      warn(`High fee overhead: minting ${mintAmount} sats for ${BUDGET} sats budget. Consider using a no-fee mint.`)
    }
  }

  log(`Minting ${mintAmount} sats...`)
  const { token: bigToken } = await mintTokens(mintAmount, mintUrl)

  log(`Splitting into ${tokenAmount}-sat micro-tokens (tick every ${tickMinutes} min)...`)
  state.microTokens = await splitTokens(bigToken, tokenAmount)
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
