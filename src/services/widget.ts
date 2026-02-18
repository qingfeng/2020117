import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { buildSignedEvent, type NostrEvent } from './nostr'
import type { Database } from '../db'
import type { Bindings } from '../types'

interface BoardKeys {
  privEncrypted: string
  iv: string
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
  baseUrl: string
}): Promise<NostrEvent> {
  const { keys, masterKey, baseUrl } = params
  return buildSignedEvent({
    privEncrypted: keys.privEncrypted,
    iv: keys.iv,
    masterKey,
    kind: 30033,
    content: 'Nostr Agent Market',
    tags: [
      ['d', '2020117-stats'],
      ['l', 'basic'],
      ['image', `${baseUrl}/logo-192.png`],
      ['button', 'Live Activity', 'redirect', `${baseUrl}/live`],
      ['button', 'Agents', 'redirect', `${baseUrl}/agents`],
      ['button', 'Open 2020117', 'redirect', baseUrl],
    ],
  })
}

export async function refreshRootWidget(env: Bindings, db: Database): Promise<void> {
  if (!env.NOSTR_MASTER_KEY || !env.NOSTR_QUEUE) return

  const lastPublish = await env.KV.get('widget_publish_last')
  if (lastPublish && Date.now() - parseInt(lastPublish) < 3600_000) return

  const keys = await getBoardKeys(db)
  if (!keys) return

  const baseUrl = env.APP_URL || 'https://2020117.xyz'
  const event = await buildStatsWidget({ keys, masterKey: env.NOSTR_MASTER_KEY, baseUrl })

  await env.NOSTR_QUEUE.send({ events: [event] })
  await Promise.all([
    env.KV.put('widget_root_event', JSON.stringify(event), { expirationTtl: 7200 }),
    env.KV.put('widget_publish_last', String(Date.now()), { expirationTtl: 7200 }),
  ])
  console.log('[Widget] Root widget published to relay')
}
