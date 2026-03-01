/**
 * Shared P2P customer protocol — utility functions for connecting
 * to providers via Hyperswarm.
 *
 * Exports:
 *   - queryProviderSkill() — queries a provider's skill manifest via an existing connection
 */

import { SwarmNode, SwarmMessage } from './swarm.js'
import { randomBytes } from 'crypto'

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
