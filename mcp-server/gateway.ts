import WebSocket from 'ws'
// @ts-expect-error Node.js v20 lacks global WebSocket, polyfill with ws
globalThis.WebSocket = WebSocket

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { NostrMCPGateway } from '@contextvm/sdk/gateway'
import { PrivateKeySigner } from '@contextvm/sdk/signer'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { nip19 } from 'nostr-tools'

// --- Config ---
const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY  // hex or nsec, required
const NOSTR_RELAYS = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol').split(',').map(s => s.trim()).filter(Boolean)

if (!NOSTR_PRIVATE_KEY) {
  console.error('NOSTR_PRIVATE_KEY env var required (64-char hex or nsec1...)')
  process.exit(1)
}

// Support both hex and nsec format
function resolvePrivateKey(input: string): string {
  if (input.startsWith('nsec1')) {
    const { type, data } = nip19.decode(input)
    if (type !== 'nsec') throw new Error('Invalid nsec')
    return Buffer.from(data).toString('hex')
  }
  // Hex — left-pad to 64 chars (keys starting with 0 may get truncated)
  return input.padStart(64, '0')
}

const normalizedKey = resolvePrivateKey(NOSTR_PRIVATE_KEY)

// Read-only tools that don't require authentication
const ALLOWED_TOOLS = new Set([
  'list_agents',
  'get_timeline',
  'get_dvm_market',
  'get_stats',
])

const signer = new PrivateKeySigner(normalizedKey)

const gateway = new NostrMCPGateway({
  mcpClientTransport: new StdioClientTransport({
    command: 'node',
    args: [new URL('./gateway-server.js', import.meta.url).pathname],
    env: { ...process.env } as Record<string, string>,
  }),
  nostrTransportOptions: {
    signer,
    relayHandler: NOSTR_RELAYS,
    isPublicServer: true,
    serverInfo: {
      name: 'Nostr DVM',
      about: 'Decentralized Agent Network — DVM marketplace, Lightning payments, Nostr identity. Read-only gateway for network discovery.',
      website: 'https://2020117.xyz',
    },
    inboundMiddleware: async (
      message: JSONRPCMessage,
      _ctx: { clientPubkey: string },
      forward: (msg: JSONRPCMessage) => Promise<void>,
    ) => {
      // Block write tool calls — only allow read-only tools
      if (
        'method' in message &&
        message.method === 'tools/call' &&
        'params' in message &&
        message.params &&
        typeof message.params === 'object' &&
        'name' in message.params &&
        !ALLOWED_TOOLS.has(message.params.name as string)
      ) {
        console.log(`[Gateway] Blocked tool call: ${(message.params as { name: string }).name}`)
        return  // drop the message — client gets no response / timeout
      }
      await forward(message)
    },
  },
})

async function main() {
  await gateway.start()
  const pubkey = await signer.getPublicKey()
  console.log(`[Gateway] 2020117 MCP Server live on Nostr (read-only mode)`)
  console.log(`[Gateway] Public key: ${pubkey}`)
  console.log(`[Gateway] Relays: ${NOSTR_RELAYS.join(', ')}`)
  console.log(`[Gateway] Allowed tools: ${[...ALLOWED_TOOLS].join(', ')}`)
  console.log(`[Gateway] CEP-6 announcement published (Kind 11316)`)

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`[Gateway] Shutting down...`)
      await gateway.stop()
      process.exit(0)
    })
  }
}

main().catch((err) => {
  console.error('[Gateway] Fatal error:', err)
  process.exit(1)
})
