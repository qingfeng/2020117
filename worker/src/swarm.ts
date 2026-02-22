/**
 * Hyperswarm P2P helper — discover peers and establish encrypted connections
 *
 * Provider: joins a topic (hash of service kind) and listens for connections
 * Customer: joins the same topic to find the provider
 *
 * Wire protocol (newline-delimited JSON) — streaming payment:
 *   → { type: "request", id, kind, input, budget }         customer sends job with budget
 *   ← { type: "offer", id, sats_per_chunk, chunks_per_payment }  provider quotes price
 *   → { type: "payment", id, token }                       customer sends micro-token
 *   ← { type: "payment_ack", id, amount }                  provider confirms + accepts
 *   ← { type: "accepted", id }                             provider starts generating
 *   ← { type: "chunk", id, data }                          streaming output (N chunks)
 *   ← { type: "pay_required", id, earned, next }           provider pauses for payment
 *   → { type: "payment", id, token }                       customer sends next micro-token
 *   ← { type: "payment_ack", id, amount }                  provider confirms
 *   ← { type: "chunk", id, data }                          more chunks...
 *   ← { type: "result", id, output, total_sats }           final result
 *   → { type: "stop", id }                                 customer stops early
 *   ← { type: "error", id, message }                       error
 */

import Hyperswarm from 'hyperswarm'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'

export interface SwarmMessage {
  type: 'request' | 'accepted' | 'chunk' | 'result' | 'error' | 'payment' | 'payment_ack' | 'offer' | 'pay_required' | 'stop'
  id: string
  kind?: number
  input?: string
  output?: string
  data?: string
  token?: string
  amount?: number
  message?: string
  // Streaming payment fields
  sats_per_chunk?: number     // offer: cost per chunk
  chunks_per_payment?: number // offer: how many chunks per payment cycle
  budget?: number             // request: customer's total budget in sats
  earned?: number             // pay_required: total sats earned so far
  next?: number               // pay_required: sats needed for next batch
  total_sats?: number         // result: final total cost
}

/**
 * Create a deterministic topic hash from a service kind number.
 * All providers of kind 5100 join the same topic so customers can find them.
 */
export function topicFromKind(kind: number): Buffer {
  return createHash('sha256').update(`2020117-dvm-kind-${kind}`).digest()
}

/**
 * Thin wrapper around Hyperswarm that handles JSON message framing
 */
export class SwarmNode extends EventEmitter {
  swarm: Hyperswarm
  connections: Map<string, any> = new Map() // remotePublicKey hex → socket
  private buffers: Map<string, string> = new Map()

  constructor() {
    super()
    this.swarm = new Hyperswarm()

    this.swarm.on('connection', (socket: any, info: any) => {
      const peerId = socket.remotePublicKey?.toString('hex') ?? 'unknown'
      console.log(`[swarm] Peer connected: ${peerId.slice(0, 12)}... (client=${info.client})`)
      this.connections.set(peerId, socket)
      this.buffers.set(peerId, '')

      socket.on('data', (buf: Buffer) => {
        const existing = this.buffers.get(peerId) ?? ''
        const combined = existing + buf.toString()
        const lines = combined.split('\n')
        // Last element is incomplete (or empty after trailing newline)
        this.buffers.set(peerId, lines.pop()!)

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg: SwarmMessage = JSON.parse(line)
            this.emit('message', msg, socket, peerId)
          } catch {
            console.warn(`[swarm] Bad JSON from ${peerId.slice(0, 12)}: ${line.slice(0, 80)}`)
          }
        }
      })

      socket.on('error', (err: Error) => {
        console.error(`[swarm] Socket error (${peerId.slice(0, 12)}): ${err.message}`)
      })

      socket.on('close', () => {
        console.log(`[swarm] Peer disconnected: ${peerId.slice(0, 12)}`)
        this.connections.delete(peerId)
        this.buffers.delete(peerId)
        this.emit('peer-leave', peerId)
      })

      this.emit('peer-join', socket, peerId, info)
    })
  }

  /** Send a JSON message to a specific peer */
  send(socket: any, msg: SwarmMessage) {
    socket.write(JSON.stringify(msg) + '\n')
  }

  /** Broadcast a JSON message to all connected peers */
  broadcast(msg: SwarmMessage) {
    const data = JSON.stringify(msg) + '\n'
    for (const socket of this.connections.values()) {
      socket.write(data)
    }
  }

  /** Join a topic as server (provider) */
  async listen(topic: Buffer) {
    const discovery = this.swarm.join(topic, { server: true, client: false })
    await discovery.flushed()
    console.log(`[swarm] Listening on topic: ${topic.toString('hex').slice(0, 16)}...`)
    return discovery
  }

  /** Join a topic as client (customer) */
  async connect(topic: Buffer) {
    const discovery = this.swarm.join(topic, { server: false, client: true })
    await discovery.flushed()
    console.log(`[swarm] Looking for peers on topic: ${topic.toString('hex').slice(0, 16)}...`)
    return discovery
  }

  /** Wait for the first peer connection (with timeout) */
  waitForPeer(timeoutMs = 15000): Promise<{ socket: any; peerId: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`No peer found within ${timeoutMs}ms`))
      }, timeoutMs)

      this.once('peer-join', (socket, peerId) => {
        clearTimeout(timer)
        resolve({ socket, peerId })
      })

      // If already have connections, resolve immediately
      if (this.connections.size > 0) {
        clearTimeout(timer)
        const [peerId, socket] = this.connections.entries().next().value!
        resolve({ socket, peerId })
      }
    })
  }

  async destroy() {
    await this.swarm.destroy()
    console.log('[swarm] Destroyed')
  }
}
