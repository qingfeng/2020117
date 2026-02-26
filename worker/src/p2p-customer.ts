/**
 * Shared P2P customer protocol — connects to a provider via Hyperswarm,
 * negotiates price, pays with Cashu micro-tokens, and streams chunks.
 *
 * Extracted from agent.ts delegateP2PStream(), customer.ts, and pipeline.ts runStep()
 * to eliminate triple duplication of the same protocol logic.
 *
 * Exports:
 *   - P2PStreamOptions — config interface
 *   - streamFromProvider() — async generator that yields chunks from a provider
 *   - queryProviderSkill() — queries a provider's skill manifest via an existing connection
 */

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { mintTokens, splitTokens } from './cashu.js'
import { randomBytes } from 'crypto'

/**
 * Configuration for a P2P streaming session.
 */
export interface P2PStreamOptions {
  /** DVM kind number (e.g. 5100 for text generation) */
  kind: number
  /** The input/prompt to send to the provider */
  input: string
  /** Total budget in sats for this session */
  budgetSats: number
  /** Maximum acceptable price per chunk in sats (default: 5) */
  maxSatsPerChunk?: number
  /** Overall timeout in milliseconds (default: 120_000) */
  timeoutMs?: number
  /** Log prefix label (default: 'p2p') */
  label?: string
  /** Additional job parameters passed in the request message */
  params?: Record<string, unknown>
}

/**
 * Connect to a provider via Hyperswarm, negotiate price, pay with Cashu
 * micro-tokens, and yield output chunks as they arrive.
 *
 * Creates and destroys its own temporary SwarmNode — callers do not need
 * to manage any swarm state.
 *
 * @example
 * ```ts
 * for await (const chunk of streamFromProvider({
 *   kind: 5100,
 *   input: 'Explain quantum computing',
 *   budgetSats: 50,
 * })) {
 *   process.stdout.write(chunk)
 * }
 * ```
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
          console.log(`[${tag}] Payment confirmed: ${msg.amount} sats`)
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

    // Send request (include params if provided)
    const requestMsg: SwarmMessage = {
      type: 'request',
      id: jobId,
      kind,
      input,
      budget: budgetSats,
    }
    if (params) {
      requestMsg.params = params
    }
    node.send(peer.socket, requestMsg)

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
 * Query a provider's skill manifest over an existing P2P connection.
 *
 * Sends a `skill_request` message and waits for a `skill_response`.
 * Returns `null` if the provider does not respond within the timeout
 * (i.e. it does not support the skill protocol).
 *
 * @param node - An already-connected SwarmNode
 * @param socket - The peer socket to query
 * @param kind - The DVM kind to ask about
 * @param timeoutMs - How long to wait for a response (default: 5000)
 */
export function queryProviderSkill(
  node: SwarmNode,
  socket: any,
  kind: number,
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  const skillJobId = randomBytes(4).toString('hex')
  node.send(socket, { type: 'skill_request', id: skillJobId, kind })

  return new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => {
      node.removeListener('message', handler)
      console.log(`[p2p] No skill response within ${timeoutMs}ms (provider may not support skill)`)
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
