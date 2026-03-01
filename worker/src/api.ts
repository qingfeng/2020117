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

interface KeyEntry {
  api_key: string
  user_id?: string
  username?: string
}

function loadApiKey(): string | null {
  if (process.env.API_2020117_KEY) return process.env.API_2020117_KEY

  const agentName = process.env.AGENT_NAME || process.env.AGENT
  for (const dir of [process.cwd(), homedir()]) {
    try {
      const raw = readFileSync(join(dir, '.2020117_keys'), 'utf-8')
      const keys = JSON.parse(raw) as Record<string, KeyEntry>
      if (agentName && keys[agentName]?.api_key) return keys[agentName].api_key
      if (!agentName) {
        const first = Object.values(keys)[0]
        if (first?.api_key) return first.api_key
      }
    } catch {
      // file not found or invalid JSON — try next
    }
  }
  return null
}

/** Returns the resolved agent name from env or first key in file */
export function loadAgentName(): string | null {
  const fromEnv = process.env.AGENT_NAME || process.env.AGENT
  if (fromEnv) return fromEnv

  for (const dir of [process.cwd(), homedir()]) {
    try {
      const raw = readFileSync(join(dir, '.2020117_keys'), 'utf-8')
      const keys = JSON.parse(raw) as Record<string, KeyEntry>
      const firstName = Object.keys(keys)[0]
      if (firstName) return firstName
    } catch {
      // try next
    }
  }
  return null
}

const API_KEY = loadApiKey()

// --- Helpers ---

async function apiGet<T>(path: string, auth = true): Promise<T | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (auth && API_KEY) headers.Authorization = `Bearer ${API_KEY}`
    const resp = await fetch(`${BASE_URL}${path}`, { headers })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      console.warn(`[api] GET ${path} failed (${resp.status}):`, data)
      return null
    }
    return (await resp.json()) as T
  } catch (e: any) {
    console.warn(`[api] GET ${path} error: ${e.message}`)
    return null
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<T | null> {
  if (!API_KEY) return null
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })
    const data = await resp.json()
    if (!resp.ok) {
      console.warn(`[api] POST ${path} failed (${resp.status}):`, data)
      return null
    }
    return data as T
  } catch (e: any) {
    console.warn(`[api] POST ${path} error: ${e.message}`)
    return null
  }
}

async function apiPut<T>(path: string, body: unknown): Promise<T | null> {
  if (!API_KEY) return null
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })
    const data = await resp.json()
    if (!resp.ok) {
      console.warn(`[api] PUT ${path} failed (${resp.status}):`, data)
      return null
    }
    return data as T
  } catch (e: any) {
    console.warn(`[api] PUT ${path} error: ${e.message}`)
    return null
  }
}

// --- Public API ---

export function hasApiKey(): boolean {
  return API_KEY !== null
}

/** Fetch the authenticated agent's profile from the platform. */
export async function getProfile(): Promise<{ lightning_address?: string; username?: string; display_name?: string; nostr_pubkey?: string } | null> {
  return apiGet('/api/me')
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
  models?: string[]
  skill?: Record<string, unknown> | null
}): Promise<unknown | null> {
  if (!API_KEY) return null
  try {
    const desc = opts.model
      ? `Streaming worker (${opts.model}) — ${opts.satsPerChunk} sat/chunk, ${opts.chunksPerPayment} chunks/payment`
      : `Streaming worker — ${opts.satsPerChunk} sat/chunk, ${opts.chunksPerPayment} chunks/payment`
    const satsPerPayment = opts.satsPerChunk * opts.chunksPerPayment
    const body: Record<string, unknown> = {
      kinds: [opts.kind],
      description: desc,
      pricing: { min_sats: satsPerPayment, max_sats: satsPerPayment },
    }
    if (opts.models && opts.models.length > 0) body.models = opts.models
    if (opts.skill) body.skill = opts.skill
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

export interface P2PStats {
  sessions: number
  earned_sats: number
  active: boolean
}

export async function sendHeartbeat(capacity?: number, p2pStats?: P2PStats): Promise<boolean> {
  if (!API_KEY) return false
  try {
    const body: Record<string, unknown> = {}
    if (capacity !== undefined) body.capacity = capacity
    if (p2pStats) body.p2p_stats = p2pStats
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

export function startHeartbeatLoop(
  capacityOrFn?: number | (() => number),
  p2pStatsFn?: () => P2PStats,
): () => void {
  const getCapacity = typeof capacityOrFn === 'function'
    ? capacityOrFn
    : () => capacityOrFn

  // Send first heartbeat immediately
  sendHeartbeat(getCapacity(), p2pStatsFn?.()).then((ok) => {
    if (ok) console.log('[api] Heartbeat sent')
  })

  const timer = setInterval(() => {
    sendHeartbeat(getCapacity(), p2pStatsFn?.()).then((ok) => {
      if (ok) console.log('[api] Heartbeat sent')
    })
  }, HEARTBEAT_INTERVAL)

  return () => clearInterval(timer)
}

// --- Provider flow ---

export interface InboxJob {
  id: string
  kind: number
  input: string
  status: string
  customer_pubkey?: string
  bid_sats?: number
  params?: Record<string, unknown>
  created_at: string
}

export async function getInbox(opts?: {
  kind?: number
  status?: string
  limit?: number
}): Promise<InboxJob[]> {
  if (!API_KEY) return []
  const params = new URLSearchParams()
  if (opts?.kind) params.set('kind', String(opts.kind))
  if (opts?.status) params.set('status', opts.status)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const data = await apiGet<{ jobs?: InboxJob[] }>(`/api/dvm/inbox${qs ? `?${qs}` : ''}`)
  return data?.jobs ?? []
}

export async function acceptJob(jobId: string): Promise<{ job_id: string; status: string; kind: number } | null> {
  return apiPost(`/api/dvm/jobs/${jobId}/accept`, {})
}

export async function sendFeedback(jobId: string, status: string, content?: string): Promise<boolean> {
  const body: Record<string, unknown> = { status }
  if (content) body.content = content
  const result = await apiPost(`/api/dvm/jobs/${jobId}/feedback`, body)
  return result !== null
}

export async function submitResult(jobId: string, content: string, amountSats?: number): Promise<boolean> {
  const body: Record<string, unknown> = { content }
  if (amountSats !== undefined) body.amount = amountSats
  const result = await apiPost(`/api/dvm/jobs/${jobId}/result`, body)
  return result !== null
}

// --- Customer flow ---

export interface JobDetail {
  id: string
  kind: number
  input: string
  status: string
  result?: string
  bid_sats?: number
  amount_paid?: number
  provider_pubkey?: string
  created_at: string
  completed_at?: string
}

export async function createJob(opts: {
  kind: number
  input: string
  bid_sats?: number
  provider?: string
}): Promise<{ job_id: string; event_id: string } | null> {
  return apiPost('/api/dvm/request', opts)
}

export async function getJob(jobId: string): Promise<JobDetail | null> {
  return apiGet(`/api/dvm/jobs/${jobId}`)
}

export async function completeJob(jobId: string): Promise<boolean> {
  const result = await apiPost(`/api/dvm/jobs/${jobId}/complete`, {})
  return result !== null
}

// --- Profile ---

export async function updateProfile(fields: {
  display_name?: string
  about?: string
  lightning_address?: string
}): Promise<boolean> {
  const result = await apiPut('/api/me', fields)
  return result !== null
}

// --- Wallet API (built-in Lightning wallet) ---

export async function walletPayInvoice(bolt11: string): Promise<{ ok: boolean; preimage?: string; amount_sats?: number; error?: string }> {
  if (!API_KEY) return { ok: false, error: 'No API key' }
  try {
    const resp = await fetch(`${BASE_URL}/api/wallet/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ bolt11 }),
    })
    const data = await resp.json() as any
    if (!resp.ok) return { ok: false, error: data.error || `HTTP ${resp.status}` }
    return { ok: true, preimage: data.preimage, amount_sats: data.amount_sats }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

export async function walletGetBalance(): Promise<number> {
  const data = await apiGet<{ balance_sats: number }>('/api/wallet/balance')
  return data?.balance_sats ?? 0
}

/**
 * Report a completed P2P session to the platform for the activity feed.
 * Content stays private — only metadata (kind, duration, sats) is sent.
 */
export async function reportSession(opts: {
  kind: number
  durationS: number
  totalSats: number
}): Promise<void> {
  try {
    await apiPost('/api/dvm/session-report', {
      kind: opts.kind,
      duration_s: opts.durationS,
      total_sats: opts.totalSats,
    })
  } catch {
    // Best-effort — don't break session cleanup
  }
}
