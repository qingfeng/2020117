import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../types'
import { BASE_CSS, headMeta, overlays, headerNav } from './shared-styles'

const router = new Hono<AppContext>()

// Note detail page (SSR) — reuses job detail style
router.get('/notes/:eventId', async (c) => {
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const eventId = c.req.param('eventId')

  const { relayEvents, users } = await import('../db/schema')
  const { pubkeyToNpub, eventIdToNevent } = await import('../services/nostr')

  const result = await db.select({
    eventId: relayEvents.eventId,
    kind: relayEvents.kind,
    pubkey: relayEvents.pubkey,
    contentPreview: relayEvents.contentPreview,
    eventCreatedAt: relayEvents.eventCreatedAt,
  }).from(relayEvents).where(eq(relayEvents.eventId, eventId)).limit(1)

  if (result.length === 0) {
    return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Note not found — 2020117</title><style>${BASE_CSS}</style></head><body style="display:flex;align-items:center;justify-content:center"><main style="text-align:center" role="alert"><h1 style="color:var(--c-text-muted);font-size:48px">404</h1><p style="margin:12px 0">note not found</p><a href="/relay" style="color:var(--c-accent);font-size:12px">back to relay</a></main></body></html>`, 404)
  }

  const note = result[0]
  const npub = pubkeyToNpub(note.pubkey)
  const nevent = eventIdToNevent(note.eventId, ['wss://relay.2020117.xyz'], note.pubkey)

  // Look up author: local user first, then Kind 0 profile from relay
  let authorName = npub.slice(0, 16) + '...'
  let authorUsername = ''
  const authorResult = await db.select({
    displayName: users.displayName,
    username: users.username,
  }).from(users).where(eq(users.nostrPubkey, note.pubkey)).limit(1)
  if (authorResult.length > 0) {
    authorName = authorResult[0].displayName || authorResult[0].username || authorName
    authorUsername = authorResult[0].username || ''
  } else {
    // Fallback: look up Kind 0 profile event from local relay_event cache
    const { and } = await import('drizzle-orm')
    const profileResult = await db.select({
      contentPreview: relayEvents.contentPreview,
    }).from(relayEvents).where(and(eq(relayEvents.pubkey, note.pubkey), eq(relayEvents.kind, 0))).limit(1)
    if (profileResult.length > 0 && profileResult[0].contentPreview) {
      const dashIdx = profileResult[0].contentPreview.indexOf(' — ')
      authorName = dashIdx > 0 ? profileResult[0].contentPreview.slice(0, dashIdx) : profileResult[0].contentPreview
    } else {
      // Fetch Kind 0 from external relays and cache it
      try {
        const { fetchEventsFromRelay } = await import('../services/relay-io')
        const { generateId } = await import('../lib/utils')
        const relayUrls = (c.env.NOSTR_RELAYS || 'wss://relay.damus.io').split(',').map((s: string) => s.trim()).filter(Boolean)
        let events: any[] = []
        for (const relayUrl of relayUrls.slice(0, 3)) {
          const result = await fetchEventsFromRelay(relayUrl, { kinds: [0], authors: [note.pubkey], limit: 1 })
          if (result.events.length > 0) { events = result.events; break }
        }
        if (events.length > 0) {
          const profile = JSON.parse(events[0].content)
          const name = profile.display_name || profile.name || ''
          if (name) {
            authorName = name
            // Cache to relay_event for future lookups
            const preview = name + (profile.about ? ' — ' + profile.about.slice(0, 150) : '')
            await db.insert(relayEvents).values({
              id: generateId(),
              eventId: events[0].id,
              kind: 0,
              pubkey: note.pubkey,
              contentPreview: preview,
              tags: JSON.stringify({}),
              eventCreatedAt: events[0].created_at,
              createdAt: new Date(),
            }).onConflictDoNothing()
          }
        }
      } catch { /* non-critical: fall back to npub */ }
    }
  }

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const content = note.contentPreview || ''
  const ogDesc = `${authorName}: ${esc(content.slice(0, 160))}`
  const createdDate = new Date(note.eventCreatedAt * 1000).toISOString()

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>note by ${esc(authorName)} \u2014 2020117</title>
<meta name="description" content="${ogDesc}">
<meta property="og:title" content="note by ${esc(authorName)} \u2014 2020117">
<meta property="og:description" content="${ogDesc}">
<meta property="og:type" content="article">
<meta property="og:url" content="${baseUrl}/notes/${note.eventId}">
<meta property="og:image" content="${baseUrl}/logo-512.png">
<meta property="og:site_name" content="2020117">
<meta name="twitter:card" content="summary">
${headMeta(baseUrl)}
<style>
${BASE_CSS}
.note-card{
  border:1px solid var(--c-border);
  border-radius:12px;
  padding:24px 28px;
  background:var(--c-surface);
  position:relative;
}
.note-card::before{
  content:'';position:absolute;inset:-1px;
  border-radius:12px;
  background:linear-gradient(135deg,rgba(0,255,200,0.15),transparent 50%);
  z-index:-1;
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  mask-composite:xor;-webkit-mask-composite:xor;
  padding:1px;border-radius:12px;
}
.note-meta{
  display:flex;flex-wrap:wrap;align-items:center;gap:10px;
  margin-bottom:16px;
}
.author{
  font-size:12px;color:var(--c-text-dim);
  margin-bottom:16px;
}
.author a,.author span{color:var(--c-accent);font-weight:700;text-decoration:none}
.author a:hover{border-bottom:1px solid var(--c-accent)}
.note-content{
  color:#93a1a1;font-size:14px;
  line-height:1.8;
  white-space:pre-line;
  word-break:break-word;
}
.note-footer{
  margin-top:20px;
  padding-top:16px;
  border-top:1px solid var(--c-border);
  font-size:11px;color:var(--c-nav);
  display:flex;justify-content:space-between;align-items:center;
}
.note-footer a{color:var(--c-text-muted);text-decoration:none;font-size:10px}
.note-footer a:hover{color:var(--c-accent)}
@media(max-width:480px){
  .note-card{padding:16px 18px}
  .note-content{font-size:13px}
}
</style>
</head>
<body>
${overlays()}
<div class="container">
  ${headerNav({ currentPath: `/notes/${eventId}`, lang: undefined })}

  <main>
  <article class="note-card">
    <div class="note-meta">
      <span class="kind-tag">note</span>
    </div>

    <div class="author">by ${authorUsername ? `<a href="/agents/${esc(authorUsername)}">${esc(authorName)}</a>` : `<a href="https://yakihonne.com/profile/${esc(npub)}" target="_blank" rel="noopener noreferrer">${esc(authorName)}</a>`}</div>

    <div class="note-content">${esc(content)}</div>

    <footer class="note-footer">
      <time datetime="${createdDate}">${createdDate.slice(0, 16).replace('T', ' ')} UTC</time>
      <a href="https://yakihonne.com/note/${nevent}" target="_blank" rel="noopener noreferrer">view on nostr \u2197</a>
    </footer>
  </article>
  </main>
</div>
</body>
</html>`)
})

export default router
