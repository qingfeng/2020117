/**
 * Shared P2P provider protocol — reusable building blocks for provider-side
 * streaming with credit-based flow control and Cashu micropayments.
 *
 * Extracted from agent.ts and provider.ts to eliminate duplication.
 * Both modules had 95%+ identical P2P protocol logic; this module
 * provides the canonical implementation.
 *
 * Consumers: agent.ts, provider.ts (will be wired in a follow-up commit)
 */

import { SwarmNode, SwarmMessage } from './swarm.js'
import { peekToken, receiveToken } from './cashu.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-connection job state for P2P streaming */
export interface P2PJobState {
  socket: any
  credit: number
  tokens: string[]
  totalEarned: number
  stopped: boolean
  paymentResolve: (() => void) | null
}

/** Options for {@link streamToCustomer} */
export interface StreamOptions {
  node: SwarmNode
  job: P2PJobState
  jobId: string
  source: AsyncIterable<string>
  satsPerChunk: number
  chunksPerPayment: number
  timeoutMs: number
  label: string
}

// ---------------------------------------------------------------------------
// Payment helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the job has positive credit or times out.
 *
 * Resolves `true` when credit is available, `false` on timeout.
 * If the job already has credit when called, resolves immediately.
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
 * Handle an incoming `payment` message: peek the token, update credit,
 * send an ack, and wake any blocked {@link waitForPayment} call.
 */
export function handlePayment(
  node: SwarmNode,
  socket: any,
  msg: SwarmMessage,
  job: P2PJobState,
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

    console.log(
      `[${label}] Payment for ${msg.id}: ${peek.amount} sats → +${chunksUnlocked} chunks (credit: ${job.credit}, total: ${job.totalEarned} sats)`,
    )
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
 * Handle an incoming `stop` message: mark the job as stopped and wake
 * any blocked {@link waitForPayment} call so the generation loop exits.
 */
export function handleStop(
  job: P2PJobState,
  jobId: string,
  label: string,
): void {
  console.log(`[${label}] P2P job ${jobId}: customer requested stop`)
  job.stopped = true
  if (job.paymentResolve) {
    job.paymentResolve()
    job.paymentResolve = null
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Stream chunks from an async source to the customer with credit-based
 * flow control.
 *
 * When credit runs out the function sends a `pay_required` message and
 * waits for the next payment (or timeout / stop).
 *
 * Returns the concatenated full output string.
 *
 * **Cleanup note**: this function does NOT delete the job from any map or
 * release any capacity slot — callers are responsible for post-stream
 * cleanup.
 */
export async function streamToCustomer(opts: StreamOptions): Promise<string> {
  const { node, job, jobId, source, satsPerChunk, chunksPerPayment, timeoutMs, label } = opts
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

        const paid = await waitForPayment(job, jobId, node, label, timeoutMs)
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

  // Send final result
  node.send(job.socket, {
    type: 'result',
    id: jobId,
    output: fullOutput,
    total_sats: job.totalEarned,
  })
  console.log(`[${label}] P2P job ${jobId} completed (${fullOutput.length} chars, ${job.totalEarned} sats earned)`)

  return fullOutput
}

// ---------------------------------------------------------------------------
// Token claiming
// ---------------------------------------------------------------------------

/**
 * Batch-claim all accumulated Cashu tokens after a job ends.
 *
 * Returns the total number of sats successfully claimed.
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
