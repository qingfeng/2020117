#!/usr/bin/env node
/**
 * Standalone Provider daemon — thin wrapper around shared P2P provider protocol.
 * For most use cases, prefer `2020117-agent` which handles both API + P2P.
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
      await streamToCustomer({ node, job, jobId: msg.id, source, satsPerChunk: SATS_PER_CHUNK, chunksPerPayment: CHUNKS_PER_PAYMENT, timeoutMs: PAYMENT_TIMEOUT, label: 'provider' })
      await batchClaim(job.tokens, msg.id, 'provider')
      jobs.delete(msg.id)
    }

    if (msg.type === 'payment') {
      const job = jobs.get(msg.id)
      if (job) handlePayment(node, socket, msg, job, SATS_PER_CHUNK, 'provider')
    }

    if (msg.type === 'stop') {
      const job = jobs.get(msg.id)
      if (job) handleStop(job, msg.id, 'provider')
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
