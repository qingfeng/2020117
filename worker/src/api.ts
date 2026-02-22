/**
 * Platform API client — registers worker on 2020117.xyz so it appears
 * in the agent directory and online-agents list.
 *
 * All platform calls are best-effort: failures log a warning and never
 * throw, so the worker keeps running in P2P-only mode.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// --- Config ---

const BASE_URL = process.env.API_2020117_URL || 'https://2020117.xyz'

function loadApiKey(): string | null {
  if (process.env.API_2020117_KEY) return process.env.API_2020117_KEY

  for (const dir of [process.cwd(), homedir()]) {
    try {
      const raw = readFileSync(join(dir, '.2020117_keys'), 'utf-8')
      const keys = JSON.parse(raw) as Record<string, { api_key: string }>
      const first = Object.values(keys)[0]
      if (first?.api_key) return first.api_key
    } catch {
      // file not found or invalid JSON — try next
    }
  }
  return null
}

const API_KEY = loadApiKey()

// --- Public API ---

export function hasApiKey(): boolean {
  return API_KEY !== null
}

export interface OnlineAgent {
  user_id: string
  username: string
  status: string
  capacity: number
  kinds: number[]
  pricing: Record<string, unknown>
  last_seen: string
}

export async function registerService(opts: {
  kind: number
  satsPerChunk: number
  chunksPerPayment: number
  model?: string
}): Promise<unknown | null> {
  if (!API_KEY) return null
  try {
    const desc = opts.model
      ? `Streaming worker (${opts.model}) — ${opts.satsPerChunk} sat/chunk, ${opts.chunksPerPayment} chunks/payment`
      : `Streaming worker — ${opts.satsPerChunk} sat/chunk, ${opts.chunksPerPayment} chunks/payment`
    const satsPerPayment = opts.satsPerChunk * opts.chunksPerPayment
    const body = {
      kinds: [opts.kind],
      description: desc,
      pricing: { min_sats: satsPerPayment, max_sats: satsPerPayment },
    }
    const resp = await fetch(`${BASE_URL}/api/dvm/services`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })
    const data = await resp.json()
    if (!resp.ok) {
      console.warn(`[api] registerService failed (${resp.status}):`, data)
      return null
    }
    console.log('[api] Service registered on platform')
    return data
  } catch (e: any) {
    console.warn(`[api] registerService error: ${e.message}`)
    return null
  }
}

export async function sendHeartbeat(capacity?: number): Promise<boolean> {
  if (!API_KEY) return false
  try {
    const body: Record<string, unknown> = {}
    if (capacity !== undefined) body.capacity = capacity
    const resp = await fetch(`${BASE_URL}/api/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      console.warn(`[api] heartbeat failed (${resp.status}):`, data)
      return false
    }
    return true
  } catch (e: any) {
    console.warn(`[api] heartbeat error: ${e.message}`)
    return false
  }
}

export async function getOnlineProviders(kind: number): Promise<OnlineAgent[]> {
  try {
    const url = `${BASE_URL}/api/agents/online?kind=${kind}`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`
    const resp = await fetch(url, { headers })
    if (!resp.ok) return []
    const data = (await resp.json()) as { agents?: OnlineAgent[] }
    return data.agents ?? []
  } catch (e: any) {
    console.warn(`[api] getOnlineProviders error: ${e.message}`)
    return []
  }
}

const HEARTBEAT_INTERVAL = 5 * 60 * 1000 // 5 minutes

export function startHeartbeatLoop(capacity?: number): () => void {
  // Send first heartbeat immediately
  sendHeartbeat(capacity).then((ok) => {
    if (ok) console.log('[api] Heartbeat sent')
  })

  const timer = setInterval(() => {
    sendHeartbeat(capacity).then((ok) => {
      if (ok) console.log('[api] Heartbeat sent')
    })
  }, HEARTBEAT_INTERVAL)

  return () => clearInterval(timer)
}
