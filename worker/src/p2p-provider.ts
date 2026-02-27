/**
 * Shared P2P provider protocol — reusable building blocks for provider-side
 * streaming with credit-based flow control and CLINK debit payments.
 *
 * Provider actively pulls payments from customer's wallet via CLINK ndebit,
 * generating invoices from their own Lightning Address via LNURL-pay.
 *
 * Consumers: agent.ts, provider.ts
 */

import { SwarmNode, SwarmMessage } from './swarm.js'
import { collectPayment } from './clink.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-connection job state for P2P streaming */
export interface P2PJobState {
  socket: any
  credit: number
  ndebit: string           // customer's ndebit1... authorization
  totalEarned: number
  stopped: boolean
}

/** Options for {@link streamToCustomer} */
export interface StreamOptions {
  node: SwarmNode
  job: P2PJobState
  jobId: string
  source: AsyncIterable<string>
  satsPerChunk: number
  chunksPerPayment: number
  lightningAddress: string  // provider's Lightning Address for invoice generation
  label: string
}

// ---------------------------------------------------------------------------
// Payment helpers
// ---------------------------------------------------------------------------

/**
 * Provider pulls a payment cycle from the customer's wallet via CLINK debit.
 *
 * Generates an invoice from the provider's Lightning Address, then sends a
 * debit request to the customer's wallet service via Nostr relay.
 *
 * Returns true if payment succeeded and credit was added.
 */
export async function collectP2PPayment(opts: {
  job: P2PJobState
  node: SwarmNode
  jobId: string
  satsPerChunk: number
  chunksPerPayment: number
  lightningAddress: string
  label: string
}): Promise<boolean> {
  const { job, node, jobId, satsPerChunk, chunksPerPayment, lightningAddress, label } = opts
  const amount = satsPerChunk * chunksPerPayment

  try {
    const result = await collectPayment({
      ndebit: job.ndebit,
      lightningAddress,
      amountSats: amount,
    })

    if (!result.ok) {
      console.log(`[${label}] P2P job ${jobId}: debit failed: ${result.error}`)
      return false
    }

    job.credit += chunksPerPayment
    job.totalEarned += amount

    console.log(
      `[${label}] P2P job ${jobId}: debit OK +${amount} sats → +${chunksPerPayment} chunks (credit: ${job.credit}, total: ${job.totalEarned} sats)`,
    )
    node.send(job.socket, { type: 'payment_ack', id: jobId, amount })
    return true
  } catch (e: any) {
    console.log(`[${label}] P2P job ${jobId}: debit error: ${e.message}`)
    return false
  }
}

/**
 * Handle an incoming `stop` message: mark the job as stopped.
 */
export function handleStop(
  job: P2PJobState,
  jobId: string,
  label: string,
): void {
  console.log(`[${label}] P2P job ${jobId}: customer requested stop`)
  job.stopped = true
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Stream chunks from an async source to the customer with credit-based
 * flow control. When credit runs out, the provider debits the customer's
 * wallet via CLINK before continuing.
 *
 * Returns the concatenated full output string.
 *
 * **Cleanup note**: this function does NOT delete the job from any map or
 * release any capacity slot — callers are responsible for post-stream
 * cleanup.
 */
export async function streamToCustomer(opts: StreamOptions): Promise<string> {
  const { node, job, jobId, source, satsPerChunk, chunksPerPayment, lightningAddress, label } = opts
  let fullOutput = ''

  try {
    for await (const chunk of source) {
      if (job.stopped) {
        console.log(`[${label}] P2P job ${jobId}: stopped by customer`)
        break
      }

      if (job.credit <= 0) {
        // Pull next payment from customer's wallet
        console.log(`[${label}] P2P job ${jobId}: credit exhausted, debiting customer...`)
        const paid = await collectP2PPayment({
          job, node, jobId, satsPerChunk, chunksPerPayment, lightningAddress, label,
        })

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
