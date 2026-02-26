# P2P Code Deduplication — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract shared P2P protocol logic from agent.ts into reusable modules, then slim down provider.ts, customer.ts, pipeline.ts to thin wrappers.

**Architecture:** agent.ts is the canonical implementation containing all P2P provider + customer + pipeline logic. provider.ts, customer.ts, pipeline.ts are earlier standalone files with 90%+ code overlap. We extract shared protocol helpers into two new modules (p2p-provider.ts for server-side, p2p-customer.ts for client-side), then rewrite all four files to use them.

**Tech Stack:** TypeScript, Hyperswarm, Cashu eCash, Node.js EventEmitter

---

## Redundancy Audit

### Provider-side duplication (agent.ts ↔ provider.ts)

| Component | agent.ts lines | provider.ts lines | Overlap |
|-----------|---------------|-------------------|---------|
| `P2PJobState` interface | 535-542 | 29-36 (`JobState`) | 100% identical |
| `waitForPayment()` | 657-681 | 171-196 | 100% identical (only log label differs) |
| `batchClaim()` | 740-756 | 254-270 | 100% identical (only log label differs) |
| `runP2PGeneration()` | 683-738 | 198-252 (`runGeneration`) | 95% — agent uses `processor.generateStream()`, provider uses `ollama.generateStream()` directly |
| Message handler (request/payment/stop) | 558-654 | 77-160 | 95% — agent has capacity management, provider doesn't |

### Customer-side duplication (agent.ts ↔ customer.ts ↔ pipeline.ts)

| Component | agent.ts lines | customer.ts lines | pipeline.ts lines | Overlap |
|-----------|---------------|-------------------|-------------------|---------|
| Offer handling + token split | 356-393 | 119-159 | 103-141 | 95% |
| `sendNextPayment()` | 339-345 | 202-207 | 181-186 | 100% |
| Payment/chunk/result handler | 395-426 | 162-199 | 143-178 | 95% |
| Mint + connect + waitForPeer | 308-319 | 52-80 | 62-88 | 90% |

### Unique code per file

- **provider.ts**: Ollama-only verification (42-55) — can be replaced by Processor abstraction
- **customer.ts**: Skill query (83-108), stdout streaming output, CLI entry
- **pipeline.ts**: Two-phase chaining (205-261), `showAvailableProviders()` (28-44), budget splitting

---

## Task 1: Create `worker/src/p2p-provider.ts` — shared provider protocol

**Files:**
- Create: `worker/src/p2p-provider.ts`

**Step 1: Write the module**

Extract from `worker/src/agent.ts` lines 534-756 into a standalone module with these exports:

```typescript
// worker/src/p2p-provider.ts
import { SwarmNode, SwarmMessage } from './swarm.js'
import { receiveToken, peekToken } from './cashu.js'

export interface P2PJobState {
  socket: any
  credit: number
  tokens: string[]
  totalEarned: number
  stopped: boolean
  paymentResolve: (() => void) | null
}

/**
 * Wait for a payment to arrive on a P2P job. Resolves true when paid,
 * false on timeout.
 */
export function waitForPayment(
  job: P2PJobState,
  jobId: string,
  node: SwarmNode,
  label: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      job.paymentResolve = null
      console.log(`[${label}] P2P job ${jobId}: payment timeout (${timeoutMs}ms)`)
      node.send(job.socket, {
        type: 'error',
        id: jobId,
        message: `Payment timeout after ${timeoutMs}ms`,
      })
      resolve(false)
    }, timeoutMs)

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

/**
 * Handle an incoming payment message: peek token, update credit, ack.
 */
export function handlePayment(
  job: P2PJobState,
  msg: SwarmMessage,
  node: SwarmNode,
  socket: any,
  satsPerChunk: number,
  label: string,
): void {
  if (!msg.token) {
    node.send(socket, { type: 'error', id: msg.id, message: 'Payment missing token' })
    return
  }

  try {
    const peek = peekToken(msg.token)
    const chunksUnlocked = Math.floor(peek.amount / satsPerChunk)
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

/**
 * Handle a stop message from customer.
 */
export function handleStop(job: P2PJobState, msg: SwarmMessage, label: string): void {
  console.log(`[${label}] P2P job ${msg.id}: customer requested stop`)
  job.stopped = true
  if (job.paymentResolve) {
    job.paymentResolve()
    job.paymentResolve = null
  }
}

/**
 * Stream chunks to customer with credit-based flow control.
 * Generic over the source — accepts any AsyncIterable<string>.
 */
export async function streamToCustomer(opts: {
  node: SwarmNode
  job: P2PJobState
  jobId: string
  source: AsyncIterable<string>
  satsPerChunk: number
  chunksPerPayment: number
  paymentTimeoutMs: number
  label: string
}): Promise<string> {
  const { node, job, jobId, source, satsPerChunk, chunksPerPayment, paymentTimeoutMs, label } = opts
  let fullOutput = ''

  try {
    for await (const chunk of source) {
      if (job.stopped) {
        console.log(`[${label}] P2P job ${jobId}: stopped by customer`)
        break
      }

      if (job.credit <= 0) {
        const nextAmount = satsPerChunk * chunksPerPayment
        node.send(job.socket, {
          type: 'pay_required',
          id: jobId,
          earned: job.totalEarned,
          next: nextAmount,
        })
        console.log(`[${label}] P2P job ${jobId}: pay_required (earned: ${job.totalEarned}, next: ${nextAmount})`)

        const paid = await waitForPayment(job, jobId, node, label, paymentTimeoutMs)
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

  return fullOutput
}

/**
 * Batch claim all accumulated Cashu tokens after a job completes.
 */
export async function batchClaim(tokens: string[], jobId: string, label: string): Promise<number> {
  if (tokens.length === 0) return 0

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
  return totalClaimed
}
```

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors (new module is standalone, no consumers yet)

**Step 3: Commit**

```bash
git add worker/src/p2p-provider.ts
git commit -m "refactor: extract shared P2P provider protocol into p2p-provider.ts"
```

---

## Task 2: Create `worker/src/p2p-customer.ts` — shared customer protocol

**Files:**
- Create: `worker/src/p2p-customer.ts`

**Step 1: Write the module**

Extract the customer-side P2P protocol (mint → connect → offer → split → pay → collect) into a reusable async generator. This is the logic shared by agent.ts `delegateP2PStream()`, customer.ts `main()`, and pipeline.ts `runStep()`.

```typescript
// worker/src/p2p-customer.ts
import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { mintTokens, splitTokens } from './cashu.js'
import { randomBytes } from 'crypto'

export interface P2PStreamOptions {
  kind: number
  input: string
  budgetSats: number
  maxSatsPerChunk?: number    // default 5
  timeoutMs?: number          // default 120_000
  label?: string              // log prefix, default "p2p"
  params?: Record<string, unknown>
}

/**
 * Connect to a P2P provider and stream results with Cashu micropayments.
 * Returns an AsyncGenerator that yields chunks as they arrive.
 *
 * Creates a temporary SwarmNode (independent from any server listener).
 * The node is destroyed when the generator returns or throws.
 */
export async function* streamFromProvider(opts: P2PStreamOptions): AsyncGenerator<string> {
  const {
    kind,
    input,
    budgetSats,
    maxSatsPerChunk = 5,
    timeoutMs = 120_000,
    label = 'p2p',
    params,
  } = opts

  const jobId = randomBytes(8).toString('hex')
  const tag = `${label}-${jobId.slice(0, 8)}`

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
      error = new Error(`P2P delegation timed out after ${timeoutMs / 1000}s`)
      wake()
    }, timeoutMs)

    node.on('message', async (msg: SwarmMessage) => {
      if (msg.id !== jobId) return

      switch (msg.type) {
        case 'offer': {
          const spc = msg.sats_per_chunk ?? 0
          const cpp = msg.chunks_per_payment ?? 0
          const satsPerPayment = spc * cpp

          if (spc > maxSatsPerChunk) {
            node.send(peer.socket, { type: 'stop', id: jobId })
            error = new Error(`Price too high: ${spc} sat/chunk > max ${maxSatsPerChunk}`)
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
      params,
    })

    // Yield chunks as they arrive
    while (true) {
      await waitForChunk()

      if (error) {
        clearTimeout(timeout)
        throw error
      }

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
 * Query a provider's skill manifest via P2P.
 * Returns null if provider doesn't support skill_request.
 */
export async function queryProviderSkill(
  node: SwarmNode,
  socket: any,
  kind: number,
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  const skillJobId = randomBytes(4).toString('hex')
  node.send(socket, { type: 'skill_request', id: skillJobId, kind })

  return new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => {
      console.log(`[p2p] No skill response (provider may not support skill)`)
      resolve(null)
    }, timeoutMs)

    const handler = (msg: SwarmMessage) => {
      if (msg.type === 'skill_response' && msg.id === skillJobId) {
        clearTimeout(timer)
        node.removeListener('message', handler)
        resolve(msg.skill || null)
      }
    }
    node.on('message', handler)
  })
}
```

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/p2p-customer.ts
git commit -m "refactor: extract shared P2P customer protocol into p2p-customer.ts"
```

---

## Task 3: Rewrite `agent.ts` to use shared modules

**Files:**
- Modify: `worker/src/agent.ts`

**Step 1: Replace provider-side code in agent.ts**

Replace the duplicated provider-side code (P2PJobState, waitForPayment, batchClaim, runP2PGeneration, message handler) with imports from `p2p-provider.ts`.

Replace the duplicated customer-side code (delegateP2PStream) with `streamFromProvider` from `p2p-customer.ts`.

Specifically:
1. Add imports: `import { P2PJobState, waitForPayment, handlePayment, handleStop, streamToCustomer, batchClaim } from './p2p-provider.js'`
2. Add import: `import { streamFromProvider } from './p2p-customer.js'`
3. Delete `interface P2PJobState` (line 534-542) — use imported one
4. Delete `waitForPayment()` function (lines 657-681) — use imported one
5. Delete `batchClaim()` function (lines 740-756) — use imported one
6. Rewrite `startSwarmListener()` to use `handlePayment()` and `handleStop()` for payment/stop messages
7. Rewrite `runP2PGeneration()` to use `streamToCustomer()`
8. Replace `delegateP2PStream()` (lines 304-460) with a thin wrapper around `streamFromProvider()`
9. Keep `pipelineStream()` and `delegateAPI()` as-is (they're agent-specific orchestration)

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/agent.ts
git commit -m "refactor: agent.ts uses shared P2P protocol modules"
```

---

## Task 4: Rewrite `provider.ts` to use shared module

**Files:**
- Modify: `worker/src/provider.ts`

**Step 1: Rewrite provider.ts as thin wrapper**

provider.ts should become ~80 lines: CLI entry + Ollama verification + setup swarm + use shared protocol.

```typescript
#!/usr/bin/env node
/**
 * Standalone Provider daemon — thin wrapper around shared P2P provider protocol.
 * For most use cases, prefer `2020117-agent` which handles both API + P2P.
 *
 * Usage:
 *   SATS_PER_CHUNK=1 CHUNKS_PER_PAYMENT=10 npx tsx src/provider.ts
 */

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { createProcessor } from './processor.js'
import { hasApiKey, registerService, startHeartbeatLoop } from './api.js'
import {
  P2PJobState, waitForPayment, handlePayment, handleStop,
  streamToCustomer, batchClaim,
} from './p2p-provider.js'

const KIND = Number(process.env.DVM_KIND) || 5100
const SATS_PER_CHUNK = Number(process.env.SATS_PER_CHUNK) || 1
const CHUNKS_PER_PAYMENT = Number(process.env.CHUNKS_PER_PAYMENT) || 10
const PAYMENT_TIMEOUT = Number(process.env.PAYMENT_TIMEOUT) || 30000

const jobs = new Map<string, P2PJobState>()

async function main() {
  const processor = await createProcessor()
  await processor.verify()
  console.log(`[provider] Processor "${processor.name}" verified`)

  // Platform registration
  let stopHeartbeat: (() => void) | null = null
  if (hasApiKey()) {
    console.log('[provider] Registering on platform...')
    await registerService({ kind: KIND, satsPerChunk: SATS_PER_CHUNK, chunksPerPayment: CHUNKS_PER_PAYMENT, model: processor.name })
    stopHeartbeat = startHeartbeatLoop()
  } else {
    console.log('[provider] No API key — P2P-only mode')
  }

  const satsPerPayment = SATS_PER_CHUNK * CHUNKS_PER_PAYMENT
  const node = new SwarmNode()
  const topic = topicFromKind(KIND)

  console.log(`[provider] Streaming payment: ${SATS_PER_CHUNK} sat/chunk, ${CHUNKS_PER_PAYMENT} chunks/payment (${satsPerPayment} sats/cycle)`)
  await node.listen(topic)
  console.log(`[provider] Listening for customers...\n`)

  node.on('message', async (msg: SwarmMessage, socket: any, peerId: string) => {
    const tag = peerId.slice(0, 8)

    if (msg.type === 'request') {
      console.log(`[provider] Job ${msg.id} from ${tag}: "${(msg.input || '').slice(0, 60)}..."`)

      const job: P2PJobState = {
        socket, credit: 0, tokens: [], totalEarned: 0, stopped: false, paymentResolve: null,
      }
      jobs.set(msg.id, job)

      node.send(socket, { type: 'offer', id: msg.id, sats_per_chunk: SATS_PER_CHUNK, chunks_per_payment: CHUNKS_PER_PAYMENT })

      const paid = await waitForPayment(job, msg.id, node, 'provider', PAYMENT_TIMEOUT)
      if (!paid) { jobs.delete(msg.id); return }

      node.send(socket, { type: 'accepted', id: msg.id })

      const source = processor.generateStream({ input: msg.input || '', params: msg.params })
      await streamToCustomer({ node, job, jobId: msg.id, source, satsPerChunk: SATS_PER_CHUNK, chunksPerPayment: CHUNKS_PER_PAYMENT, paymentTimeoutMs: PAYMENT_TIMEOUT, label: 'provider' })
      await batchClaim(job.tokens, msg.id, 'provider')
      jobs.delete(msg.id)
    }

    if (msg.type === 'payment') {
      const job = jobs.get(msg.id)
      if (job) handlePayment(job, msg, node, socket, SATS_PER_CHUNK, 'provider')
    }

    if (msg.type === 'stop') {
      const job = jobs.get(msg.id)
      if (job) handleStop(job, msg, 'provider')
    }
  })

  process.on('SIGINT', async () => {
    console.log('\n[provider] Shutting down...')
    if (stopHeartbeat) stopHeartbeat()
    await node.destroy()
    process.exit(0)
  })
}

main().catch(err => { console.error('[provider] Fatal:', err); process.exit(1) })
```

Key changes:
- Replaced hardcoded Ollama import with `createProcessor()` — now supports all processor types
- Replaced inline `waitForPayment`/`batchClaim`/`runGeneration` with shared module
- Reduced from 276 lines to ~80 lines

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/provider.ts
git commit -m "refactor: provider.ts uses shared P2P protocol (276→80 lines)"
```

---

## Task 5: Rewrite `customer.ts` to use shared module

**Files:**
- Modify: `worker/src/customer.ts`

**Step 1: Rewrite customer.ts as thin wrapper**

customer.ts should become ~80 lines: CLI entry + skill query + `streamFromProvider()` + stdout output.

```typescript
#!/usr/bin/env node
/**
 * Standalone P2P Customer — connects to a provider, streams results with Cashu payments.
 *
 * Usage:
 *   2020117-customer --kind=5100 --budget=50 "Explain quantum computing"
 */

// CLI args → env
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

import { SwarmNode, topicFromKind } from './swarm.js'
import { streamFromProvider, queryProviderSkill } from './p2p-customer.js'

const KIND = Number(process.env.DVM_KIND) || 5100
const BUDGET_SATS = Number(process.env.BUDGET_SATS) || 100
const MAX_SATS_PER_CHUNK = Number(process.env.MAX_SATS_PER_CHUNK) || 5

async function main() {
  const prompt = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ')
  if (!prompt) {
    console.error('Usage: 2020117-customer --kind=5100 --budget=50 "your prompt here"')
    process.exit(1)
  }

  console.log(`[customer] Prompt: "${prompt.slice(0, 60)}..."`)
  console.log(`[customer] Budget: ${BUDGET_SATS} sats, max price: ${MAX_SATS_PER_CHUNK} sat/chunk`)

  // Optional: query skill before streaming
  const node = new SwarmNode()
  const topic = topicFromKind(KIND)
  await node.connect(topic)

  let peer: { socket: any; peerId: string }
  try {
    peer = await node.waitForPeer(30_000)
  } catch {
    console.error('[customer] No provider found within 30s.')
    await node.destroy()
    process.exit(1)
  }

  console.log(`[customer] Connected to provider: ${peer.peerId.slice(0, 12)}...`)

  const skill = await queryProviderSkill(node, peer.socket, KIND)
  if (skill) {
    console.log(`[customer] Provider skill: ${(skill as any).name} v${(skill as any).version}`)
    if ((skill as any).features) {
      console.log(`[customer] Features: ${((skill as any).features as string[]).join(', ')}`)
    }
  }

  await node.destroy()

  // Stream from provider
  let output = ''
  for await (const chunk of streamFromProvider({
    kind: KIND,
    input: prompt,
    budgetSats: BUDGET_SATS,
    maxSatsPerChunk: MAX_SATS_PER_CHUNK,
    label: 'customer',
  })) {
    process.stdout.write(chunk)
    output += chunk
  }

  console.log(`\n[customer] Done (${output.length} chars)`)
}

main().catch(err => { console.error('[customer] Fatal:', err.message || err); process.exit(1) })
```

Key changes:
- Replaced 150+ lines of inline protocol handling with `streamFromProvider()`
- Skill query uses `queryProviderSkill()` from shared module
- Reduced from 246 lines to ~80 lines

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/customer.ts
git commit -m "refactor: customer.ts uses shared P2P protocol (246→80 lines)"
```

---

## Task 6: Rewrite `pipeline.ts` to use shared module

**Files:**
- Modify: `worker/src/pipeline.ts`

**Step 1: Rewrite pipeline.ts as thin wrapper**

pipeline.ts should become ~80 lines: CLI entry + two calls to `streamFromProvider()`.

```typescript
#!/usr/bin/env node
/**
 * Pipeline — chain multiple P2P providers in sequence.
 *
 * Usage:
 *   BUDGET_SATS=100 TARGET_LANG=Chinese npm run pipeline "Write a short poem"
 */

import { streamFromProvider } from './p2p-customer.js'
import { getOnlineProviders } from './api.js'

const BUDGET_SATS = Number(process.env.BUDGET_SATS) || 100
const MAX_SATS_PER_CHUNK = Number(process.env.MAX_SATS_PER_CHUNK) || 5
const GEN_KIND = Number(process.env.GEN_KIND) || 5100
const TRANS_KIND = Number(process.env.TRANS_KIND) || 5302
const TARGET_LANG = process.env.TARGET_LANG || 'Chinese'

async function showProviders(kind: number, label: string) {
  try {
    const agents = await getOnlineProviders(kind)
    if (agents.length === 0) {
      console.log(`[${label}] No providers online for kind ${kind}`)
    } else {
      console.log(`[${label}] ${agents.length} provider(s) online for kind ${kind}:`)
      for (const a of agents) {
        const cap = a.capacity !== undefined ? `, capacity: ${a.capacity}` : ''
        const price = a.pricing ? `, pricing: ${JSON.stringify(a.pricing)}` : ''
        console.log(`[${label}]   - ${a.username || a.user_id} (${a.status}${cap}${price})`)
      }
    }
  } catch {
    console.log(`[${label}] Could not query platform`)
  }
}

async function collectStream(opts: Parameters<typeof streamFromProvider>[0]): Promise<string> {
  let output = ''
  for await (const chunk of streamFromProvider(opts)) {
    process.stdout.write(chunk)
    output += chunk
  }
  return output
}

async function main() {
  const prompt = process.argv.slice(2).join(' ')
  if (!prompt) {
    console.error('Usage: BUDGET_SATS=100 TARGET_LANG=Chinese npm run pipeline "your prompt"')
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
  await showProviders(GEN_KIND, 'gen')

  const generated = await collectStream({
    kind: GEN_KIND, input: prompt, budgetSats: genBudget,
    maxSatsPerChunk: MAX_SATS_PER_CHUNK, label: 'gen',
  })

  if (!generated.trim()) {
    console.error('\n[pipeline] Phase 1 produced no output, aborting')
    process.exit(1)
  }

  // Phase 2: Translation
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Phase 2: Translation to ${TARGET_LANG} (budget: ${transBudget} sats)`)
  console.log('─'.repeat(60))
  await showProviders(TRANS_KIND, 'trans')

  const translated = await collectStream({
    kind: TRANS_KIND, input: `Translate the following text to ${TARGET_LANG}:\n\n${generated}`,
    budgetSats: transBudget, maxSatsPerChunk: MAX_SATS_PER_CHUNK, label: 'trans',
  })

  // Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log('Pipeline complete!')
  console.log('='.repeat(60))
  console.log(`\nGenerated (${generated.length} chars):\n${generated}`)
  console.log(`\nTranslated (${translated.length} chars):\n${translated}`)
}

main().catch(err => { console.error('[pipeline] Fatal:', err.message || err); process.exit(1) })
```

Key changes:
- Replaced 130-line `runStep()` with `streamFromProvider()` call
- Reduced from 267 lines to ~80 lines

**Step 2: Verify it compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/pipeline.ts
git commit -m "refactor: pipeline.ts uses shared P2P protocol (267→80 lines)"
```

---

## Task 7: Update exports in `package.json` and verify build

**Files:**
- Modify: `worker/package.json`

**Step 1: Add new module exports**

Add the two new modules to the `exports` field so external consumers can import them:

```json
{
  "exports": {
    "./processor": "./dist/processor.js",
    "./swarm": "./dist/swarm.js",
    "./cashu": "./dist/cashu.js",
    "./api": "./dist/api.js",
    "./p2p-provider": "./dist/p2p-provider.js",
    "./p2p-customer": "./dist/p2p-customer.js"
  }
}
```

**Step 2: Full build and verify**

Run: `cd worker && npm run build`
Expected: Clean build, no errors. All dist/*.js files generated.

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add worker/package.json
git commit -m "refactor: export new P2P protocol modules from package"
```

---

## Task 8: Delete dead code — `worker/src/adapters/ollama.ts`

**Files:**
- Check: `worker/src/adapters/ollama.ts` — likely the original ollama adapter used by provider.ts directly

**Step 1: Verify it's unused**

After the refactor, provider.ts now uses `createProcessor()` from processor.ts, which imports `ollama-processor.ts`. Check if `ollama.ts` is imported anywhere:

Run: `grep -r "from.*ollama.js" worker/src/ --include="*.ts" | grep -v ollama-processor | grep -v node_modules`

If only the old provider.ts imported it (and we've removed that import), delete `worker/src/adapters/ollama.ts`.

**Step 2: Delete if unused**

```bash
rm worker/src/adapters/ollama.ts
```

**Step 3: Verify build**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add -A worker/src/adapters/ollama.ts
git commit -m "refactor: remove unused ollama.ts adapter (replaced by ollama-processor.ts)"
```

---

## Summary

| File | Before | After | Change |
|------|--------|-------|--------|
| `p2p-provider.ts` | — | ~120 lines | NEW: shared provider protocol |
| `p2p-customer.ts` | — | ~150 lines | NEW: shared customer protocol |
| `agent.ts` | 800 lines | ~500 lines | -300 lines (uses shared modules) |
| `provider.ts` | 276 lines | ~80 lines | -196 lines |
| `customer.ts` | 246 lines | ~80 lines | -166 lines |
| `pipeline.ts` | 267 lines | ~80 lines | -187 lines |
| `adapters/ollama.ts` | exists | deleted | Dead code removal |
| **Total** | ~1589 lines | ~1010 lines | **-579 lines** (~36% reduction) |

Net code reduction is ~579 lines, but more importantly: zero protocol duplication. Future P2P changes (like the session feature) only need to touch the shared modules.
