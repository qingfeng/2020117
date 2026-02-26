# P2P Interactive Session — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-minute interactive sessions over Hyperswarm — customer rents a provider's service, pays with Cashu per minute, uses it via CLI REPL or HTTP proxy (browser → P2P tunnel → provider's WebUI).

**Architecture:** New `session.ts` (customer-side CLI entry point) handles connection, billing timer, REPL, and local HTTP proxy. Provider-side session handling is added to `agent.ts`'s swarm listener. `swarm.ts` gets new message types. No platform changes needed.

**Tech Stack:** TypeScript, Hyperswarm, Cashu eCash, Node.js `http.createServer` (HTTP proxy), `readline` (REPL)

---

## Task 1: Extend SwarmMessage with session + HTTP proxy types

**Files:**
- Modify: `worker/src/swarm.ts:29-48`

**Step 1: Add new message types to the `type` union and add new fields**

In `worker/src/swarm.ts`, update the `SwarmMessage` interface:

```typescript
export interface SwarmMessage {
  type: 'request' | 'accepted' | 'chunk' | 'result' | 'error' | 'payment' | 'payment_ack' | 'offer' | 'pay_required' | 'stop' | 'skill_request' | 'skill_response'
    | 'session_start' | 'session_ack' | 'session_tick' | 'session_tick_ack' | 'session_end'
    | 'http_request' | 'http_response'
  id: string
  kind?: number
  input?: string
  output?: string
  data?: string
  token?: string
  amount?: number
  message?: string
  params?: Record<string, unknown>
  skill?: Record<string, unknown> | null
  // Streaming payment fields
  sats_per_chunk?: number
  chunks_per_payment?: number
  budget?: number
  earned?: number
  next?: number
  total_sats?: number
  // Session fields
  session_id?: string
  sats_per_minute?: number
  balance?: number
  duration_s?: number
  // HTTP proxy fields
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  status?: number
}
```

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors (all existing code still works — new fields are optional)

**Step 3: Commit**

```bash
git add worker/src/swarm.ts
git commit -m "feat: add session and HTTP proxy message types to SwarmMessage"
```

---

## Task 2: Add provider-side session handling to agent.ts

**Files:**
- Modify: `worker/src/agent.ts`

This adds three things to agent.ts:
1. A `SessionState` map tracking active sessions
2. Message handlers for `session_start`, `session_tick`, `session_end`, `http_request`
3. A session timeout mechanism (2 missed ticks → auto-end)

**Step 1: Add session state and handler**

After the `p2pJobs` map (around line 382), add a session state map:

```typescript
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
```

In the `startSwarmListener` function's message handler, add new cases BEFORE the existing `request` handler. Add these at the top of the `node.on('message', ...)` callback, after the `skill_request` handler:

```typescript
    // --- Session protocol ---

    if (msg.type === 'session_start') {
      const satsPerMinute = state.skill?.pricing
        ? (state.skill.pricing as any).sats_per_minute
        : null

      if (!satsPerMinute) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Provider does not support sessions (no pricing.sats_per_minute in skill)' })
        return
      }

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

      // Start timeout checker — if no tick for 2 minutes, end session
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

        const remainingBalance = msg.budget
          ? msg.budget - session.totalEarned
          : undefined

        console.log(`[${label}] Session ${session.sessionId}: tick ${peek.amount} sats (total: ${session.totalEarned})`)
        node.send(socket, {
          type: 'session_tick_ack',
          id: msg.id,
          session_id: session.sessionId,
          balance: remainingBalance,
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

      // Forward to local backend (PROCESSOR URL)
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

    // Also handle request/result within active session context
    if (msg.type === 'request' && msg.session_id) {
      const session = activeSessions.get(msg.session_id)
      if (!session) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Unknown session' })
        return
      }
      // Process normally — the existing request handler runs below
      // but skip payment negotiation (session pays per-minute, not per-chunk)
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
```

And add helper functions near `runP2PGeneration`:

```typescript
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
```

Also add `import { randomBytes } from 'crypto'` and `import { peekToken } from './cashu.js'` back to the imports (they were removed during the refactor but are needed here for session tick handling).

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/agent.ts
git commit -m "feat: add provider-side session handling (session_start/tick/end + http_request forwarding)"
```

---

## Task 3: Create session.ts — customer-side session client

**Files:**
- Create: `worker/src/session.ts`

This is the main new file — a standalone CLI tool that:
1. Connects to a provider via Hyperswarm
2. Queries skill → gets `pricing.sats_per_minute`
3. Mints Cashu tokens, splits into per-minute micro-tokens
4. Sends `session_start` → receives `session_ack`
5. Starts a 60-second tick timer (sends `session_tick` with micro-token each minute)
6. Starts an HTTP proxy server on `--port` (default 8080)
7. Starts a CLI REPL for `generate`, `status`, `skill`, `quit`
8. On quit or budget exhausted → `session_end` → cleanup

**Step 1: Write the full session.ts**

```typescript
#!/usr/bin/env node
/**
 * P2P Interactive Session — rent a provider's service over Hyperswarm.
 *
 * Two interaction modes (same process):
 *   1. CLI REPL: generate "prompt" --steps=40
 *   2. HTTP proxy: browser → localhost:8080 → P2P → provider's WebUI
 *
 * Payment: per-minute Cashu micro-tokens, automatic tick every 60s.
 *
 * Usage:
 *   npx 2020117-session --kind=5200 --budget=500 --port=8080
 */

// --- CLI args → env ---
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue
  const eq = arg.indexOf('=')
  if (eq === -1) continue
  const key = arg.slice(0, eq)
  const val = arg.slice(eq + 1)
  switch (key) {
    case '--kind':     process.env.DVM_KIND = val; break
    case '--budget':   process.env.SESSION_BUDGET = val; break
    case '--port':     process.env.SESSION_PORT = val; break
    case '--agent':    process.env.AGENT = val; break
    case '--provider': process.env.SESSION_PROVIDER = val; break
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
const BUDGET = Number(process.env.SESSION_BUDGET) || 500
const PORT = Number(process.env.SESSION_PORT) || 8080

// --- State ---
interface SessionClientState {
  node: SwarmNode
  socket: any
  peerId: string
  sessionId: string | null
  satsPerMinute: number
  microTokens: string[]
  tokenIndex: number
  totalSpent: number
  startedAt: number
  tickTimer: ReturnType<typeof setInterval> | null
  skill: Record<string, unknown> | null
  pendingRequests: Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>
  pendingHttp: Map<string, { resolve: (v: { status: number; headers: Record<string, string>; body: string }) => void; reject: (e: Error) => void }>
  ended: boolean
}

let S: SessionClientState

// --- Main ---
async function main() {
  console.log(`[session] Budget: ${BUDGET} sats | Kind: ${KIND} | Proxy port: ${PORT}`)

  // 1. Connect to provider
  const node = new SwarmNode()
  const topic = topicFromKind(KIND)
  await node.connect(topic)

  let peer: { socket: any; peerId: string }
  try {
    peer = await node.waitForPeer(30_000)
  } catch {
    console.error('[session] No provider found within 30s')
    await node.destroy()
    process.exit(1)
  }

  console.log(`[session] Connected to provider: ${peer.peerId.slice(0, 12)}...`)

  // 2. Query skill
  const skill = await queryProviderSkill(node, peer.socket, KIND)
  if (skill) {
    console.log(`[session] Skill: ${(skill as any).name} v${(skill as any).version} (${((skill as any).features || []).join(', ')})`)
  }

  const satsPerMinute = skill?.pricing
    ? ((skill.pricing as any).sats_per_minute as number)
    : null

  if (!satsPerMinute) {
    console.error('[session] Provider does not declare pricing.sats_per_minute in skill')
    await node.destroy()
    process.exit(1)
  }

  console.log(`[session] Pricing: ${satsPerMinute} sats/min`)
  const estimatedMinutes = Math.floor(BUDGET / satsPerMinute)
  console.log(`[session] Budget: ${BUDGET} sats (≈${estimatedMinutes} min)`)

  // 3. Mint & split tokens
  console.log(`[session] Minting ${BUDGET} sats...`)
  const { token: bigToken } = await mintTokens(BUDGET)
  const microTokens = await splitTokens(bigToken, satsPerMinute)
  console.log(`[session] Ready: ${microTokens.length} tokens of ${satsPerMinute} sats`)

  // 4. Init state
  S = {
    node,
    socket: peer.socket,
    peerId: peer.peerId,
    sessionId: null,
    satsPerMinute,
    microTokens,
    tokenIndex: 0,
    totalSpent: 0,
    startedAt: 0,
    tickTimer: null,
    skill,
    pendingRequests: new Map(),
    pendingHttp: new Map(),
    ended: false,
  }

  // 5. Set up message handler
  node.on('message', handleMessage)

  // Handle peer disconnect
  node.on('peer-leave', (leftPeerId: string) => {
    if (leftPeerId === S.peerId) {
      console.log('\n[session] Provider disconnected')
      cleanup()
    }
  })

  // 6. Send session_start
  const startId = randomBytes(4).toString('hex')
  node.send(peer.socket, {
    type: 'session_start',
    id: startId,
    budget: BUDGET,
    sats_per_minute: satsPerMinute,
  })

  // Wait for session_ack
  const acked = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      console.error('[session] Provider did not acknowledge session within 10s')
      resolve(false)
    }, 10_000)

    const handler = (msg: SwarmMessage) => {
      if (msg.type === 'session_ack' && msg.id === startId) {
        clearTimeout(timer)
        node.removeListener('message', handler)
        S.sessionId = msg.session_id || null
        S.startedAt = Date.now()
        resolve(true)
      }
      if (msg.type === 'error' && msg.id === startId) {
        clearTimeout(timer)
        node.removeListener('message', handler)
        console.error(`[session] Provider rejected: ${msg.message}`)
        resolve(false)
      }
    }
    node.on('message', handler)
  })

  if (!acked || !S.sessionId) {
    await node.destroy()
    process.exit(1)
  }

  console.log(`[session] Session started: ${S.sessionId}`)

  // 7. Start tick timer — send first tick immediately, then every 60s
  sendTick()
  S.tickTimer = setInterval(sendTick, 60_000)

  // 8. Start HTTP proxy
  startHttpProxy()

  // 9. Start REPL
  console.log(`[session] Web proxy ready at http://localhost:${PORT}`)
  console.log(`[session] Type 'help' for commands\n`)
  startRepl()

  // 10. SIGINT
  process.on('SIGINT', () => {
    console.log('\n[session] Interrupted')
    endSessionAndExit()
  })
}

// --- Message handler ---

function handleMessage(msg: SwarmMessage) {
  switch (msg.type) {
    case 'session_tick_ack':
      // Logged in sendTick
      break

    case 'session_end': {
      const durationS = msg.duration_s ?? Math.round((Date.now() - S.startedAt) / 1000)
      console.log(`\n[session] Session ended by provider. Total: ${msg.total_sats ?? S.totalSpent} sats for ${durationS}s`)
      cleanup()
      break
    }

    case 'result': {
      const pending = S.pendingRequests.get(msg.id)
      if (pending) {
        pending.resolve(msg.output || '')
        S.pendingRequests.delete(msg.id)
      }
      break
    }

    case 'http_response': {
      const pending = S.pendingHttp.get(msg.id)
      if (pending) {
        pending.resolve({
          status: msg.status || 200,
          headers: msg.headers || {},
          body: msg.body || '',
        })
        S.pendingHttp.delete(msg.id)
      }
      break
    }

    case 'error': {
      const pendingReq = S.pendingRequests.get(msg.id)
      if (pendingReq) {
        pendingReq.reject(new Error(msg.message || 'Unknown error'))
        S.pendingRequests.delete(msg.id)
      }
      const pendingHttp = S.pendingHttp.get(msg.id)
      if (pendingHttp) {
        pendingHttp.reject(new Error(msg.message || 'Unknown error'))
        S.pendingHttp.delete(msg.id)
      }
      break
    }
  }
}

// --- Tick payment ---

function sendTick() {
  if (S.ended) return

  if (S.tokenIndex >= S.microTokens.length) {
    console.log('[session] Budget exhausted')
    endSessionAndExit()
    return
  }

  // Warn when low
  const remaining = S.microTokens.length - S.tokenIndex
  if (remaining <= 2) {
    const remainingSats = remaining * S.satsPerMinute
    console.log(`[session] ⚠ Low balance: ${remainingSats} sats (≈${remaining} min)`)
  }

  const token = S.microTokens[S.tokenIndex++]
  S.totalSpent += S.satsPerMinute

  S.node.send(S.socket, {
    type: 'session_tick',
    id: randomBytes(4).toString('hex'),
    session_id: S.sessionId!,
    token,
    budget: BUDGET,
  })

  const elapsed = Math.round((Date.now() - S.startedAt) / 1000)
  console.log(`[session] Tick ${S.tokenIndex}/${S.microTokens.length}: ${S.satsPerMinute} sats (total: ${S.totalSpent}, elapsed: ${elapsed}s)`)
}

// --- HTTP Proxy ---

function startHttpProxy() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (S.ended) {
      res.writeHead(503)
      res.end('Session ended')
      return
    }

    // Collect body
    const bodyChunks: Buffer[] = []
    for await (const chunk of req) {
      bodyChunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(bodyChunks).toString()

    const reqId = randomBytes(4).toString('hex')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v
    }

    // Send over P2P
    S.node.send(S.socket, {
      type: 'http_request',
      id: reqId,
      session_id: S.sessionId!,
      method: req.method || 'GET',
      path: req.url || '/',
      headers,
      body: body || undefined,
    })

    // Wait for response
    try {
      const httpRes = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
        S.pendingHttp.set(reqId, { resolve, reject })
        setTimeout(() => {
          if (S.pendingHttp.has(reqId)) {
            S.pendingHttp.delete(reqId)
            reject(new Error('HTTP proxy timeout (60s)'))
          }
        }, 60_000)
      })

      // Forward response headers, but skip hop-by-hop headers
      const skipHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive'])
      for (const [k, v] of Object.entries(httpRes.headers)) {
        if (!skipHeaders.has(k.toLowerCase())) {
          res.setHeader(k, v)
        }
      }

      res.writeHead(httpRes.status)
      res.end(httpRes.body)
    } catch (e: any) {
      res.writeHead(502)
      res.end(JSON.stringify({ error: e.message }))
    }
  })

  server.listen(PORT, () => {
    // Logged in main
  })
}

// --- CLI REPL ---

function startRepl() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  })

  rl.prompt()

  rl.on('line', async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) { rl.prompt(); return }

    if (trimmed === 'quit' || trimmed === 'exit') {
      endSessionAndExit()
      return
    }

    if (trimmed === 'status') {
      const elapsed = Math.round((Date.now() - S.startedAt) / 1000)
      const mins = Math.floor(elapsed / 60)
      const secs = elapsed % 60
      const remainingSats = (S.microTokens.length - S.tokenIndex) * S.satsPerMinute
      const remainingMins = S.microTokens.length - S.tokenIndex
      console.log(`[session] Connected: ${mins}m${secs}s | Spent: ${S.totalSpent} sats | Remaining: ${remainingSats} sats (≈${remainingMins} min)`)
      rl.prompt()
      return
    }

    if (trimmed === 'skill') {
      if (S.skill) {
        console.log(JSON.stringify(S.skill, null, 2))
      } else {
        console.log('[session] No skill info available')
      }
      rl.prompt()
      return
    }

    if (trimmed === 'help') {
      console.log('Commands:')
      console.log('  generate "prompt" --key=val   Generate with provider')
      console.log('  status                        Balance, duration info')
      console.log('  skill                         Show provider capabilities')
      console.log('  quit                          End session')
      rl.prompt()
      return
    }

    if (trimmed.startsWith('generate ')) {
      const rest = trimmed.slice('generate '.length)
      // Parse: first quoted string is prompt, rest are --key=val params
      const promptMatch = rest.match(/^"([^"]*)"(.*)$/) || rest.match(/^'([^']*)'(.*)$/)
      let prompt: string
      let paramStr: string
      if (promptMatch) {
        prompt = promptMatch[1]
        paramStr = promptMatch[2]
      } else {
        // No quotes — entire rest is prompt, no params
        prompt = rest
        paramStr = ''
      }

      const params: Record<string, unknown> = {}
      for (const match of paramStr.matchAll(/--(\w+)=(\S+)/g)) {
        const val = match[2]
        params[match[1]] = isNaN(Number(val)) ? val : Number(val)
      }

      const reqId = randomBytes(4).toString('hex')

      console.log(`[session] Generating...`)
      const startTime = Date.now()

      S.node.send(S.socket, {
        type: 'request',
        id: reqId,
        session_id: S.sessionId!,
        kind: KIND,
        input: prompt,
        params: Object.keys(params).length > 0 ? params : undefined,
      })

      try {
        const result = await new Promise<string>((resolve, reject) => {
          S.pendingRequests.set(reqId, { resolve, reject })
          setTimeout(() => {
            if (S.pendingRequests.has(reqId)) {
              S.pendingRequests.delete(reqId)
              reject(new Error('Generate timeout (120s)'))
            }
          }, 120_000)
        })

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

        // If result looks like base64 image, save to file
        if (result.length > 1000 && /^[A-Za-z0-9+/=\s]+$/.test(result.slice(0, 200))) {
          mkdirSync('output', { recursive: true })
          const fileNum = String(S.pendingRequests.size + S.tokenIndex).padStart(3, '0')
          const filename = `output/${fileNum}.png`
          writeFileSync(filename, Buffer.from(result, 'base64'))
          console.log(`[session] Saved: ./${filename} (${elapsed}s)`)
        } else {
          console.log(`[session] Result (${elapsed}s): ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`)
        }
      } catch (e: any) {
        console.error(`[session] Error: ${e.message}`)
      }

      rl.prompt()
      return
    }

    console.log(`[session] Unknown command: "${trimmed}". Type 'help' for commands.`)
    rl.prompt()
  })

  rl.on('close', () => {
    endSessionAndExit()
  })
}

// --- Cleanup ---

function endSessionAndExit() {
  if (S.ended) return
  S.ended = true

  if (S.tickTimer) {
    clearInterval(S.tickTimer)
    S.tickTimer = null
  }

  const durationS = Math.round((Date.now() - S.startedAt) / 1000)

  if (S.sessionId) {
    S.node.send(S.socket, {
      type: 'session_end',
      id: S.sessionId,
      session_id: S.sessionId,
      total_sats: S.totalSpent,
      duration_s: durationS,
    })
  }

  console.log(`[session] Session ended. Total: ${S.totalSpent} sats for ${durationS}s.`)

  setTimeout(async () => {
    await S.node.destroy()
    process.exit(0)
  }, 500)
}

function cleanup() {
  if (S.ended) return
  S.ended = true

  if (S.tickTimer) {
    clearInterval(S.tickTimer)
    S.tickTimer = null
  }

  setTimeout(async () => {
    await S.node.destroy()
    process.exit(0)
  }, 500)
}

// --- Entry ---

main().catch(err => {
  console.error('[session] Fatal:', err.message || err)
  process.exit(1)
})
```

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/session.ts
git commit -m "feat: add P2P session client (CLI REPL + HTTP proxy + per-minute billing)"
```

---

## Task 4: Register session CLI in package.json

**Files:**
- Modify: `worker/package.json`

**Step 1: Add bin entry and dev script**

Add to `bin`:
```json
"2020117-session": "./dist/session.js"
```

Add to `scripts`:
```json
"dev:session": "npx tsx src/session.ts"
```

**Step 2: Full build**

Run: `cd worker && npm run build`
Expected: Clean build, all dist/*.js generated including session.js

**Step 3: Commit**

```bash
git add worker/package.json
git commit -m "feat: register 2020117-session CLI command"
```

---

## Task 5: Verify end-to-end with typecheck + build

**Files:**
- None (verification only)

**Step 1: Full typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: Zero errors

**Step 2: Full build**

Run: `cd worker && npm run build`
Expected: Clean build

**Step 3: Verify dist files exist**

Run: `ls -la worker/dist/session.js worker/dist/p2p-provider.js worker/dist/p2p-customer.js`
Expected: All three files present

---

## Summary

| Task | File | Change |
|------|------|--------|
| 1 | `swarm.ts` | Add session + HTTP proxy message types |
| 2 | `agent.ts` | Provider-side session handlers (start/tick/end/http_request) |
| 3 | `session.ts` | NEW: Customer-side session client (REPL + HTTP proxy + billing) |
| 4 | `package.json` | Register `2020117-session` bin |
| 5 | — | Verify typecheck + build |

Total: ~400 lines of new code, 2 modified files, 1 new file.
