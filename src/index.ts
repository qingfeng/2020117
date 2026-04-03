import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDb } from './db'
import apiRoutes from './routes/api'
import landingPage from './pages/landing'
import relayPage from './pages/relay'
import agentsPage from './pages/agents'
import jobsPage from './pages/jobs'
import notesPage from './pages/notes'
import marketPage from './pages/market'
import statsPage from './pages/stats'
import skillPage from './pages/skill'
import chatPage from './pages/chat'
import mePage from './pages/me'
import { scheduled } from './cron'
import type { AppContext } from './types'

const app = new Hono<AppContext>()

// DB middleware
app.use('*', async (c, next) => {
  const db = createDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)
  c.set('db', db)
  c.set('user', null)
  await next()
})

// Cache headers for pages (5 min) and API (1 min)
app.use('*', async (c, next) => {
  await next()
  const path = new URL(c.req.url).pathname
  if (!c.res.headers.has('Cache-Control')) {
    if (path.startsWith('/api/')) {
      c.res.headers.set('Cache-Control', 'public, max-age=60, s-maxage=60')
    } else if (path === '/' || path.startsWith('/relay') || path.startsWith('/timeline') || path.startsWith('/agents') || path.startsWith('/jobs') || path.startsWith('/notes') || path.startsWith('/dvm/market') || path.startsWith('/stats')) {
      c.res.headers.set('Cache-Control', 'public, max-age=300, s-maxage=300')
    }
  }
})

// Page routes
app.route('/', landingPage)
app.route('/', relayPage)
app.route('/', agentsPage)
app.route('/', jobsPage)
app.route('/', notesPage)
app.route('/', marketPage)
app.route('/', statsPage)
app.route('/', chatPage)
app.route('/', mePage)
app.route('/skill.md', skillPage)

// NIP-05 Nostr verification
app.get('/.well-known/nostr.json', async (c) => {
  const db = c.get('db')
  const name = c.req.query('name')

  if (!name) return c.json({ names: {} })

  const { users } = await import('./db/schema')
  const user = await db.select({ username: users.username, nostrPubkey: users.nostrPubkey, nip05Enabled: users.nip05Enabled })
    .from(users)
    .where(eq(users.username, name))
    .limit(1)

  if (user.length === 0 || !user[0].nostrPubkey || !user[0].nip05Enabled) {
    return c.json({ names: {} })
  }

  const relayUrl = c.env.NOSTR_RELAY_URL || (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
  const relays: Record<string, string[]> = {}
  if (relayUrl) {
    relays[user[0].nostrPubkey] = [relayUrl]
  }

  return c.json({
    names: { [user[0].username]: user[0].nostrPubkey },
    relays,
  }, 200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'max-age=3600',
  })
})


// GET /topic/:id — public topic view (JSON)
app.get('/topic/:id', async (c) => {
  const db = c.get('db')
  const { topics, users } = await import('./db/schema')
  const result = await db.select({
    id: topics.id,
    title: topics.title,
    content: topics.content,
    nostrEventId: topics.nostrEventId,
    nostrAuthorPubkey: topics.nostrAuthorPubkey,
    createdAt: topics.createdAt,
    userId: topics.userId,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    nostrPubkey: users.nostrPubkey,
  }).from(topics).leftJoin(users, eq(topics.userId, users.id)).where(eq(topics.id, c.req.param('id'))).limit(1)

  if (!result.length) return c.json({ error: 'not found' }, 404)

  const t = result[0]
  const { stripHtml } = await import('./lib/utils')
  const { pubkeyToNpub, eventIdToNevent } = await import('./services/nostr')
  const relays = (c.env.NOSTR_RELAYS || '').split(',').map((s: string) => s.trim()).filter(Boolean)
  const authorPubkey = t.nostrPubkey || t.nostrAuthorPubkey || undefined

  return c.json({
    id: t.id,
    content: stripHtml(t.content || '').trim(),
    author: t.userId
      ? { username: t.username, display_name: t.displayName, avatar_url: t.avatarUrl }
      : { pubkey: t.nostrAuthorPubkey, npub: t.nostrAuthorPubkey ? pubkeyToNpub(t.nostrAuthorPubkey) : null },
    created_at: t.createdAt,
    ...(t.nostrEventId
      ? { nostr_event_id: t.nostrEventId, nevent: eventIdToNevent(t.nostrEventId, relays, authorPubkey) }
      : {}),
  })
})

// API routes
app.route('/api', apiRoutes)


export default {
  fetch: app.fetch,
  scheduled,
}
