import type { NostrEvent } from './nostr'

// --- WebSocket Publish ---

export async function publishEventToRelay(relayUrl: string, event: NostrEvent): Promise<boolean> {
  try {
    const httpUrl = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://')
    const resp = await fetch(httpUrl, { headers: { Upgrade: 'websocket' } })
    const ws = (resp as any).webSocket as WebSocket
    if (!ws) return false
    ws.accept()
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { try { ws.close() } catch {} resolve(false) }, 5000)
      ws.addEventListener('message', (msg: MessageEvent) => {
        try {
          const data = JSON.parse(msg.data as string)
          if (data[0] === 'OK' && data[1] === event.id) {
            clearTimeout(timeout)
            try { ws.close() } catch {}
            resolve(!!data[2])
          }
        } catch {}
      })
      ws.send(JSON.stringify(['EVENT', event]))
    })
  } catch {
    return false
  }
}

// --- WebSocket REQ ---

export type RelayResult = { events: NostrEvent[]; success: boolean }

export async function fetchEventsFromRelay(
  relayUrl: string,
  filter: Record<string, any>,
  retries = 1,
): Promise<RelayResult> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await _fetchEventsFromRelayOnce(relayUrl, filter)
      if (result.closedEarly && attempt < retries) {
        // Wait before retry on early close
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      return { events: result.events, success: !result.closedEarly }
    } catch (e) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      throw e
    }
  }
  return { events: [], success: false }
}

async function _fetchEventsFromRelayOnce(
  relayUrl: string,
  filter: Record<string, any>,
): Promise<{ events: NostrEvent[]; closedEarly: boolean }> {
  const httpUrl = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://')
  const resp = await fetch(httpUrl, {
    headers: { Upgrade: 'websocket' },
  })

  const ws = (resp as any).webSocket as WebSocket
  if (!ws) {
    throw new Error(`WebSocket upgrade failed for ${relayUrl}`)
  }
  ws.accept()

  const subId = 'nip72-' + Math.random().toString(36).slice(2, 8)
  const events: NostrEvent[] = []

  return new Promise<{ events: NostrEvent[]; closedEarly: boolean }>((resolve) => {
    let gotEose = false

    const timeout = setTimeout(() => {
      try {
        ws.send(JSON.stringify(['CLOSE', subId]))
        ws.close()
      } catch {}
      resolve({ events, closedEarly: false })
    }, 15000)

    ws.addEventListener('message', (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data as string)
        if (!Array.isArray(data)) return

        if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
          events.push(data[2] as NostrEvent)
        } else if (data[0] === 'EOSE' && data[1] === subId) {
          gotEose = true
          clearTimeout(timeout)
          try {
            ws.send(JSON.stringify(['CLOSE', subId]))
            ws.close()
          } catch {}
          resolve({ events, closedEarly: false })
        } else if (data[0] === 'CLOSED' || data[0] === 'NOTICE') {
          console.warn(`[Relay] ${relayUrl}: ${data[0]}: ${data.slice(1).join(' ')}`)
        }
      } catch {}
    })

    ws.addEventListener('close', (ev: CloseEvent) => {
      const closedEarly = !gotEose && events.length === 0
      if (closedEarly) {
        console.warn(`[Relay] ${relayUrl} closed early (code=${ev.code}), will retry`)
      }
      clearTimeout(timeout)
      resolve({ events, closedEarly })
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      resolve({ events, closedEarly: true })
    })

    // Send REQ
    ws.send(JSON.stringify(['REQ', subId, filter]))
  })
}
