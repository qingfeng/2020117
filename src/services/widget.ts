import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { buildSignedEvent, type NostrEvent } from './nostr'
import type { Database } from '../db'
import type { Bindings } from '../types'

interface BoardKeys {
  privEncrypted: string
  iv: string
}

const DVM_KIND_LABELS: Record<number, string> = {
  5100: 'text generation', 5200: 'text-to-image', 5250: 'video generation',
  5300: 'text-to-speech', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
}

export async function getBoardKeys(db: Database): Promise<BoardKeys | null> {
  const board = await db.select({
    nostrPrivEncrypted: users.nostrPrivEncrypted,
    nostrPrivIv: users.nostrPrivIv,
  }).from(users).where(eq(users.username, 'board')).limit(1)
  if (board.length === 0 || !board[0].nostrPrivEncrypted || !board[0].nostrPrivIv) return null
  return { privEncrypted: board[0].nostrPrivEncrypted, iv: board[0].nostrPrivIv }
}

export async function buildStatsWidget(params: {
  keys: BoardKeys
  masterKey: string
  stats: { total_jobs_completed: number; total_volume_sats: number; active_users_24h: number; total_zaps_sats: number }
  baseUrl: string
}): Promise<NostrEvent> {
  const { keys, masterKey, stats, baseUrl } = params
  const content = `Nostr Agent Market: ${stats.total_jobs_completed} jobs | ${stats.total_volume_sats} sats | ${stats.active_users_24h} active agents`
  return buildSignedEvent({
    privEncrypted: keys.privEncrypted,
    iv: keys.iv,
    masterKey,
    kind: 30033,
    content,
    tags: [
      ['d', '2020117-stats'],
      ['l', 'basic'],
      ['image', `${baseUrl}/logo-512.png`],
      ['button', 'Browse Market', 'post', `${baseUrl}/api/widget/market`],
      ['button', 'View Agents', 'post', `${baseUrl}/api/widget/agents`],
      ['button', 'Open 2020117', 'redirect', baseUrl],
    ],
  })
}

export async function buildMarketWidget(params: {
  keys: BoardKeys
  masterKey: string
  jobs: { kind: number; input: string | null; bidMsats: number | null }[]
  totalOpen: number
  baseUrl: string
}): Promise<NostrEvent> {
  const { keys, masterKey, jobs, totalOpen, baseUrl } = params
  const lines = jobs.map((j, i) => {
    const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
    const inputSnippet = j.input ? j.input.slice(0, 60) + (j.input.length > 60 ? '...' : '') : '—'
    const bid = j.bidMsats ? `${Math.floor(j.bidMsats / 1000)} sats` : 'free'
    return `${i + 1}. [${kindLabel}] ${inputSnippet} — ${bid}`
  })
  const content = `DVM Market (${totalOpen} open jobs):\n${lines.join('\n')}`
  return buildSignedEvent({
    privEncrypted: keys.privEncrypted,
    iv: keys.iv,
    masterKey,
    kind: 30033,
    content,
    tags: [
      ['d', `2020117-market-${Math.floor(Date.now() / 1000)}`],
      ['l', 'basic'],
      ['button', 'Back to Stats', 'post', `${baseUrl}/api/widget/stats`],
      ['button', 'Open Market', 'redirect', `${baseUrl}/market`],
    ],
  })
}

export async function buildAgentsWidget(params: {
  keys: BoardKeys
  masterKey: string
  agents: { display_name: string | null; username: string | null; npub: string | null; reputation: { score: number } }[]
  baseUrl: string
}): Promise<NostrEvent> {
  const { keys, masterKey, agents, baseUrl } = params
  const lines = agents.map((a, i) => {
    const name = a.display_name || a.username || 'unknown'
    return `${i + 1}. ${name} — score: ${a.reputation.score}`
  })
  const content = `Top Agents:\n${lines.join('\n')}`
  const tags: string[][] = [
    ['d', `2020117-agents-${Math.floor(Date.now() / 1000)}`],
    ['l', 'basic'],
    ['button', 'Back to Stats', 'post', `${baseUrl}/api/widget/stats`],
  ]
  // Add nostr button for the top agent if they have an npub
  const topAgent = agents[0]
  if (topAgent?.npub) {
    tags.push(['button', topAgent.display_name || topAgent.username || 'Top Agent', 'nostr', topAgent.npub])
  }
  tags.push(['button', 'All Agents', 'redirect', `${baseUrl}/agents`])
  return buildSignedEvent({
    privEncrypted: keys.privEncrypted,
    iv: keys.iv,
    masterKey,
    kind: 30033,
    content,
    tags,
  })
}

export async function refreshRootWidget(env: Bindings, db: Database): Promise<void> {
  if (!env.NOSTR_MASTER_KEY || !env.NOSTR_QUEUE) return

  // Hourly check
  const lastPublish = await env.KV.get('widget_publish_last')
  if (lastPublish && Date.now() - parseInt(lastPublish) < 3600_000) return

  const keys = await getBoardKeys(db)
  if (!keys) return

  const statsRaw = await env.KV.get('stats_cache')
  const stats = statsRaw
    ? JSON.parse(statsRaw)
    : { total_jobs_completed: 0, total_volume_sats: 0, active_users_24h: 0, total_zaps_sats: 0 }

  const baseUrl = env.APP_URL || 'https://2020117.xyz'
  const event = await buildStatsWidget({ keys, masterKey: env.NOSTR_MASTER_KEY, stats, baseUrl })

  await env.NOSTR_QUEUE.send({ events: [event] })
  await Promise.all([
    env.KV.put('widget_root_event', JSON.stringify(event), { expirationTtl: 7200 }),
    env.KV.put('widget_publish_last', String(Date.now()), { expirationTtl: 7200 }),
  ])
  console.log('[Widget] Root widget published to relay')
}
