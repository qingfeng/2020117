/**
 * Shared P2P customer protocol — connects to a provider via Hyperswarm,
 * negotiates price, authorizes CLINK debit payments, and streams chunks.
 *
 * The customer sends an ndebit authorization with the request. The provider
 * pulls payments directly from the customer's wallet via CLINK debit —
 * the customer does not send payment messages.
 *
 * Exports:
 *   - P2PStreamOptions — config interface
 *   - streamFromProvider() — async generator that yields chunks from a provider
 *   - queryProviderSkill() — queries a provider's skill manifest via an existing connection
 */

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { randomBytes } from 'crypto'

/**
 * Configuration for a P2P connection.
 */
export interface P2PStreamOptions {
  /** DVM kind number (e.g. 5100 for text generation) */
  kind: number
  /** The input/prompt to send to the provider */
  input: string
  /** Total budget in sats for this session */
  budgetSats: number
  /** Customer's ndebit1... authorization for CLINK debit payments */
  ndebit: string
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
 * Connect to a provider via Hyperswarm, authorize CLINK debit payments,
 * and yield output chunks as they arrive.
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
 *   ndebit: 'ndebit1...',
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
    ndebit,
    maxSatsPerChunk = 5,
    timeoutMs = 120_000,
    label = 'p2p',
    params,
  } = opts

  if (!ndebit) {
    throw new Error('ndebit authorization required for P2P connection')
  }

  const jobId = randomBytes(8).toString('hex')
  const tag = `${label}-${jobId.slice(0, 8)}`

  const node = new SwarmNode()
  const topic = topicFromKind(kind)

  try {
    console.log(`[${tag}] Looking for kind ${kind} provider...`)
    await node.connect(topic)

    const peer = await node.waitForPeer(30_000)
    console.log(`[${tag}] Connected to provider: ${peer.peerId.slice(0, 12)}...`)

    // Query provider's skill manifest for pricing before committing
    const skill = await queryProviderSkill(node, peer.socket, kind)
    if (skill) {
      const pricing = skill.pricing as Record<string, unknown> | undefined
      const jobPrice = pricing?.sats_per_job ?? pricing?.[String(kind)]
      if (jobPrice !== undefined) {
        console.log(`[${tag}] Provider pricing: ${jobPrice} sats/job`)
        if (typeof jobPrice === 'number' && jobPrice > budgetSats) {
          throw new Error(`Provider price ${jobPrice} sats exceeds budget ${budgetSats} sats`)
        }
      }
      if (skill.name) console.log(`[${tag}] Provider: ${skill.name}`)
    }

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

          if (spc > maxSatsPerChunk) {
            node.send(peer.socket, { type: 'stop', id: jobId })
            error = new Error(`Price too high: ${spc} sat/chunk > max ${maxSatsPerChunk}`)
            wake()
            return
          }

          console.log(`[${tag}] Offer: ${spc} sat/chunk, ${msg.chunks_per_payment ?? 0} chunks/payment`)
          // No action needed — provider will debit our wallet via CLINK
          break
        }

        case 'payment_ack':
          // Provider debited our wallet and is reporting the amount
          console.log(`[${tag}] Provider debited: ${msg.amount} sats`)
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
          // With CLINK, provider handles payment collection directly
          // This shouldn't normally fire, but log it if it does
          console.log(`[${tag}] Provider requested payment (will be debited via CLINK)`)
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

    // Send request with ndebit authorization (provider will use it to debit)
    const requestMsg: SwarmMessage = {
      type: 'request',
      id: jobId,
      kind,
      input,
      budget: budgetSats,
      ndebit,
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
