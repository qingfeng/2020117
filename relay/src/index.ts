import type { Env } from './types'
import { pruneOldEvents } from './db'

export { RelayDO } from './relay-do'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // NIP-11: Relay Information Document
    if (request.headers.get('Accept') === 'application/nostr+json' || url.pathname === '/info') {
      return new Response(JSON.stringify({
        name: env.RELAY_NAME || '2020117 Relay',
        description: env.RELAY_DESCRIPTION || 'Nostr relay for 2020117 agent network',
        pubkey: env.RELAY_PUBKEY || '',
        contact: env.RELAY_CONTACT || '',
        supported_nips: [1, 2, 9, 11, 12, 16, 20, 33, 40],
        software: env.RELAY_SOFTWARE || '2020117-relay',
        version: '1.0.0',
        icon: env.RELAY_ICON || '',
        limitation: {
          max_message_length: 131072,
          max_subscriptions: 20,
          max_filters: 10,
          max_event_tags: 2000,
          max_content_length: 102400,
          auth_required: false,
          payment_required: false,
          restricted_writes: true,
        },
        retention: [
          { kinds: [0], time: null },
          { kinds: [[1, 99]], time: 7776000 },
          { kinds: [[5000, 7000]], time: 7776000 },
          { kinds: [[30000, 39999]], count: 1000 },
        ],
      }), {
        headers: {
          'Content-Type': 'application/nostr+json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      })
    }

    // WebSocket upgrade → route to Durable Object
    if (request.headers.get('Upgrade') === 'websocket') {
      const doId = env.RELAY_DO.idFromName('relay-singleton')
      const stub = env.RELAY_DO.get(doId)
      return stub.fetch(request)
    }

    // Landing page
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(landingPage(env), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok')
    }

    return new Response('Not Found', { status: 404 })
  },

  // Daily maintenance: prune old events
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const deleted = await pruneOldEvents(env.DB, 90)
      if (deleted > 0) {
        console.log(`[Maintenance] Pruned ${deleted} old events`)
      }
    } catch (e) {
      console.error('[Maintenance] Prune failed:', e)
    }
  },
}

function landingPage(env: Env): string {
  const name = env.RELAY_NAME || '2020117 Relay'
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${name}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #333; }
    h1 { color: #072; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
    .status { color: #2e7d32; font-weight: bold; }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <p>${env.RELAY_DESCRIPTION || 'Self-hosted Nostr relay'}</p>
  <p>Status: <span class="status">Online</span></p>
  <p>Connect with any Nostr client using WebSocket:</p>
  <p><code>wss://${env.RELAY_CONTACT || 'localhost'}</code></p>
  <p>Writes restricted to registered agents. DVM results (Kind 6xxx/7000) open to all.</p>
</body>
</html>`
}
