#!/usr/bin/env node
/**
 * Standalone Provider daemon — thin wrapper around shared P2P provider protocol.
 * For most use cases, prefer `2020117-agent` which handles both API + P2P.
 */

// --- CLI args → env (before any imports) ---
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue
  const eq = arg.indexOf('=')
  if (eq === -1) continue
  const key = arg.slice(0, eq)
  const val = arg.slice(eq + 1)
  switch (key) {
    case '--kind':              process.env.DVM_KIND = val; break
    case '--lightning-address':  process.env.LIGHTNING_ADDRESS = val; break
  }
}

import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { createProcessor } from './processor.js'
import { hasApiKey, registerService, startHeartbeatLoop } from './api.js'
import { initClinkAgent, collectPayment } from './clink.js'
import { P2PJobState, collectP2PPayment, handleStop, streamToCustomer } from './p2p-provider.js'

const KIND = Number(process.env.DVM_KIND) || 5100
const SATS_PER_CHUNK = Number(process.env.SATS_PER_CHUNK) || 1
const CHUNKS_PER_PAYMENT = Number(process.env.CHUNKS_PER_PAYMENT) || 10
const LIGHTNING_ADDRESS = process.env.LIGHTNING_ADDRESS || ''

const jobs = new Map<string, P2PJobState>()

async function main() {
  if (!LIGHTNING_ADDRESS) {
    console.error('[provider] Error: --lightning-address=you@wallet.com required')
    process.exit(1)
  }

  const processor = await createProcessor()
  await processor.verify()
  console.log(`[provider] Processor "${processor.name}" verified`)

  // Initialize CLINK agent identity
  const { pubkey } = initClinkAgent()
  console.log(`[provider] CLINK: ${LIGHTNING_ADDRESS} (agent pubkey: ${pubkey.slice(0, 16)}...)`)

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

      if (!msg.ndebit) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Request requires ndebit authorization' })
        return
      }

      if (msg.budget !== undefined) {
        console.log(`[provider] Customer budget: ${msg.budget} sats`)
      }

      const job: P2PJobState = {
        socket, credit: 0, ndebit: msg.ndebit, totalEarned: 0, stopped: false,
      }
      jobs.set(msg.id, job)

      node.send(socket, { type: 'offer', id: msg.id, sats_per_chunk: SATS_PER_CHUNK, chunks_per_payment: CHUNKS_PER_PAYMENT })

      // Debit first payment cycle via CLINK
      const paid = await collectP2PPayment({
        job, node, jobId: msg.id,
        satsPerChunk: SATS_PER_CHUNK, chunksPerPayment: CHUNKS_PER_PAYMENT,
        lightningAddress: LIGHTNING_ADDRESS, label: 'provider',
      })
      if (!paid) { jobs.delete(msg.id); return }

      node.send(socket, { type: 'accepted', id: msg.id })

      const source = processor.generateStream({ input: msg.input || '', params: msg.params })
      await streamToCustomer({
        node, job, jobId: msg.id, source,
        satsPerChunk: SATS_PER_CHUNK, chunksPerPayment: CHUNKS_PER_PAYMENT,
        lightningAddress: LIGHTNING_ADDRESS, label: 'provider',
      })
      jobs.delete(msg.id)
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
