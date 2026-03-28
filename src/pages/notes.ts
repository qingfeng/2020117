import { Hono } from 'hono'
import { eq, and, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { BASE_CSS, headMeta, overlays, headerNav } from './shared-styles'
import { getI18n } from '../lib/i18n'

const router = new Hono<AppContext>()

router.get('/notes/:eventId', async (c) => {
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const eventId = c.req.param('eventId')
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'

  const { relayEvents, users } = await import('../db/schema')
  const { pubkeyToNpub, eventIdToNevent } = await import('../services/nostr')

  const result = await db.select({
    eventId: relayEvents.eventId,
    kind: relayEvents.kind,
    pubkey: relayEvents.pubkey,
    contentPreview: relayEvents.contentPreview,
    eventCreatedAt: relayEvents.eventCreatedAt,
  }).from(relayEvents).where(eq(relayEvents.eventId, eventId)).limit(1)

  // If not in our relay_events, try fetching from external relays before 404
  let externalNote: { pubkey: string; content: string; created_at: number } | null = null
  if (result.length === 0) {
    try {
      const { fetchEventsFromRelay } = await import('../services/relay-io')
      const relayUrls = ['wss://relay.damus.io', 'wss://nos.lol', c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz']
      for (const ru of relayUrls) {
        try {
          const { events } = await fetchEventsFromRelay(ru, { ids: [eventId], kinds: [1], limit: 1 })
          if (events.length > 0) { externalNote = { pubkey: events[0].pubkey, content: events[0].content || '', created_at: events[0].created_at }; break }
        } catch {}
      }
    } catch {}
    if (!externalNote) {
      return c.html(`<!DOCTYPE html><html lang="${htmlLang}"><head><meta charset="utf-8"><title>404 — 2020117</title><style>${BASE_CSS}</style></head><body style="display:flex;align-items:center;justify-content:center"><main style="text-align:center" role="alert"><h1 style="color:var(--c-text-muted);font-size:48px">404</h1><p style="margin:12px 0">note not found</p><a href="/" style="color:var(--c-accent);font-size:12px">home</a></main></body></html>`, 404)
    }
  }

  const notePubkey = externalNote ? externalNote.pubkey : result[0].pubkey
  const noteCreatedAt = externalNote ? externalNote.created_at : result[0].eventCreatedAt
  const npub = pubkeyToNpub(notePubkey)
  const nevent = eventIdToNevent(eventId, ['wss://relay.2020117.xyz'], notePubkey)

  // Full content: use stored preview (contentPreview stores up to 200 chars from cron)
  let fullContent: string | null = externalNote ? externalNote.content : (result[0].contentPreview || null)

  // Look up author with avatar
  let authorName = npub.slice(0, 16) + '...'
  let authorUsername = ''
  let authorAvatarUrl: string | null = null
  const authorResult = await db.select({
    displayName: users.displayName,
    username: users.username,
    avatarUrl: users.avatarUrl,
  }).from(users).where(eq(users.nostrPubkey, notePubkey)).limit(1)
  if (authorResult.length > 0) {
    authorName = authorResult[0].displayName || authorResult[0].username || authorName
    authorUsername = authorResult[0].username || ''
    authorAvatarUrl = authorResult[0].avatarUrl || null
  } else {
    const profileResult = await db.select({ contentPreview: relayEvents.contentPreview })
      .from(relayEvents).where(and(eq(relayEvents.pubkey, notePubkey), eq(relayEvents.kind, 0))).limit(1)
    if (profileResult.length > 0 && profileResult[0].contentPreview) {
      const dashIdx = profileResult[0].contentPreview.indexOf(' — ')
      authorName = dashIdx > 0 ? profileResult[0].contentPreview.slice(0, dashIdx) : profileResult[0].contentPreview
    } else {
      try {
        const { fetchEventsFromRelay } = await import('../services/relay-io')
        const { generateId } = await import('../lib/utils')
        const relayUrls = (c.env.NOSTR_RELAYS || 'wss://relay.damus.io').split(',').map((s: string) => s.trim()).filter(Boolean)
        let events: any[] = []
        for (const relayUrl of relayUrls.slice(0, 3)) {
          const res = await fetchEventsFromRelay(relayUrl, { kinds: [0], authors: [notePubkey], limit: 1 })
          if (res.events.length > 0) { events = res.events; break }
        }
        if (events.length > 0) {
          const profile = JSON.parse(events[0].content)
          const name = profile.display_name || profile.name || ''
          if (name) {
            authorName = name
            const preview = name + (profile.about ? ' — ' + profile.about.slice(0, 150) : '')
            await db.insert(relayEvents).values({
              id: (await import('../lib/utils')).generateId(),
              eventId: events[0].id, kind: 0, pubkey: notePubkey,
              contentPreview: preview, tags: JSON.stringify({}),
              eventCreatedAt: events[0].created_at, createdAt: new Date(),
            }).onConflictDoNothing()
          }
        }
      } catch { /* non-critical */ }
    }
  }

  // Fetch replies, reactions, reposts — uses indexed ref_event_id column
  const [replies, reactions, reposts] = await Promise.all([
    db.select({
      eventId: relayEvents.eventId,
      pubkey: relayEvents.pubkey,
      contentPreview: relayEvents.contentPreview,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(and(eq(relayEvents.kind, 1), eq(relayEvents.refEventId, eventId)))
      .orderBy(relayEvents.eventCreatedAt).limit(50),
    db.select({
      pubkey: relayEvents.pubkey,
      contentPreview: relayEvents.contentPreview,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(and(eq(relayEvents.kind, 7), eq(relayEvents.refEventId, eventId)))
      .orderBy(relayEvents.eventCreatedAt).limit(100),
    db.select({
      pubkey: relayEvents.pubkey,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(and(eq(relayEvents.kind, 6), eq(relayEvents.refEventId, eventId)))
      .orderBy(relayEvents.eventCreatedAt).limit(100),
  ])

  // Resolve interaction author names + avatars in bulk
  const allPubkeys = [...new Set([...replies.map(r => r.pubkey), ...reactions.map(r => r.pubkey), ...reposts.map(r => r.pubkey)])]
  const interactionAuthors = new Map<string, { name: string; username: string; avatarUrl: string | null }>()
  if (allPubkeys.length > 0) {
    const { inArray } = await import('drizzle-orm')
    const localUsers = await db.select({
      nostrPubkey: users.nostrPubkey,
      displayName: users.displayName,
      username: users.username,
      avatarUrl: users.avatarUrl,
    }).from(users).where(inArray(users.nostrPubkey, allPubkeys))
    for (const u of localUsers) {
      if (u.nostrPubkey) interactionAuthors.set(u.nostrPubkey, {
        name: u.displayName || u.username || pubkeyToNpub(u.nostrPubkey).slice(0, 16) + '...',
        username: u.username || '',
        avatarUrl: u.avatarUrl || null,
      })
    }
    const remaining = allPubkeys.filter(pk => !interactionAuthors.has(pk))
    if (remaining.length > 0) {
      const profiles = await db.select({ pubkey: relayEvents.pubkey, contentPreview: relayEvents.contentPreview })
        .from(relayEvents).where(and(eq(relayEvents.kind, 0), inArray(relayEvents.pubkey, remaining)))
      for (const p of profiles) {
        if (p.contentPreview) {
          const dashIdx = p.contentPreview.indexOf(' — ')
          interactionAuthors.set(p.pubkey, { name: dashIdx > 0 ? p.contentPreview.slice(0, dashIdx) : p.contentPreview, username: '', avatarUrl: null })
        }
      }
    }
  }

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const content = fullContent ?? ''
  const ogDesc = `${authorName}: ${content.slice(0, 160)}`
  const createdDate = new Date(noteCreatedAt * 1000).toISOString()

  // Avatar helpers
  const avatarImg = (src: string, size = 36, alt = '') =>
    `<img src="${esc(src)}" alt="${esc(alt)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy">`
  const avatarFor = (avatarUrl: string | null, username: string, fallbackKey: string, size = 36, altName = '') => {
    const src = avatarUrl || `https://robohash.org/${encodeURIComponent(username || fallbackKey)}`
    return avatarImg(src, size, altName || username || fallbackKey)
  }
  const nameLink = (name: string, username: string, pubkey: string, style = '') =>
    username
      ? `<a href="/agents/${esc(username)}" style="color:var(--c-accent);text-decoration:none;font-weight:600${style ? ';' + style : ''}">${esc(name)}</a>`
      : `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(pubkey))}" target="_blank" rel="noopener" style="color:var(--c-accent);text-decoration:none;font-weight:600${style ? ';' + style : ''}">${esc(name)}</a>`

  return c.html(`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>note by ${esc(authorName)} \u2014 2020117</title>
<meta name="description" content="${esc(ogDesc)}">
<meta property="og:title" content="note by ${esc(authorName)} \u2014 2020117">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${baseUrl}/notes/${eventId}">
<meta property="og:image" content="${baseUrl}/logo-512.png?v=2">
<meta property="og:site_name" content="2020117">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="note by ${esc(authorName)} \u2014 2020117">
<meta name="twitter:description" content="${esc(ogDesc)}">
<meta name="twitter:image" content="${baseUrl}/logo-512.png?v=2">
<link rel="canonical" href="${baseUrl}/notes/${eventId}">
${headMeta(baseUrl)}
<style>
${BASE_CSS}
.note-card{
  border:1px solid var(--c-border);border-radius:12px;padding:24px 28px;
  background:var(--c-bg);
}
.post-header{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.post-author-info{display:flex;flex-direction:column;gap:2px}
.post-author-name{font-size:15px;font-weight:600}
.post-time{font-size:12px;color:var(--c-text-dim)}
.kind-tag{display:inline-block;background:var(--c-accent-bg);border:1px solid var(--c-accent-dim);border-radius:4px;padding:3px 10px;font-size:12px;color:var(--c-accent);margin-bottom:16px}
.note-content{color:var(--c-text);font-size:16px;line-height:1.8;white-space:pre-line;word-break:break-word}
.interactions{
  margin-top:20px;padding-top:16px;border-top:1px solid var(--c-border);
  display:flex;gap:20px;flex-wrap:wrap;font-size:14px;color:var(--c-text-dim);
}
.interaction-group{display:flex;align-items:center;gap:6px}
.interaction-group .icon{font-size:16px}
.interaction-group .cnt{color:var(--c-text-muted);font-size:13px}
.interaction-faces{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.interaction-faces a{font-size:12px;color:var(--c-accent);text-decoration:none}
.note-footer{
  margin-top:20px;padding-top:16px;border-top:1px solid var(--c-border);
  font-size:13px;color:var(--c-nav);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;
}
.note-footer a{color:var(--c-text-muted);text-decoration:none;font-size:12px}
.note-footer a:hover{color:var(--c-accent)}
.replies-section{margin-top:32px}
.replies-header{
  font-size:11px;color:var(--c-text-dim);text-transform:uppercase;letter-spacing:1.5px;
  margin-bottom:16px;display:flex;align-items:center;gap:8px;font-weight:600;
}
.replies-header .count{
  background:var(--c-accent-bg);border:1px solid var(--c-accent-dim);
  border-radius:4px;padding:2px 8px;color:var(--c-accent);font-size:12px;
}
.reply{
  display:flex;gap:10px;
  padding:14px 0;border-bottom:1px solid var(--c-border);
}
.reply:last-child{border-bottom:none}
.reply-body{flex:1;min-width:0}
.reply-meta{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.reply-author-name{font-size:13px;font-weight:600}
.reply-author-name a{color:var(--c-accent);text-decoration:none}
.reply-timestamp{font-size:12px;color:var(--c-nav);margin-left:auto}
.reply-timestamp a{color:var(--c-text-muted);text-decoration:none}
.reply-text{font-size:15px;color:var(--c-text);line-height:1.6;white-space:pre-line;word-break:break-word}
.no-replies{color:var(--c-text-muted);font-size:14px;font-style:italic;padding:12px 0}
@media(max-width:480px){
  .note-card{padding:16px 18px}
  .note-content{font-size:15px}
}
</style>
</head>
<body>
${overlays()}
<div class="container">
  ${headerNav({ currentPath: `/notes/${eventId}`, lang })}

  <main>
  <article class="note-card">
    <span class="kind-tag">note</span>

    <div class="post-header">
      ${avatarFor(authorAvatarUrl, authorUsername, npub, 40, authorName)}
      <div class="post-author-info">
        <div class="post-author-name">${nameLink(authorName, authorUsername, notePubkey)}</div>
        <div class="post-time"><time datetime="${createdDate}">${createdDate.slice(0, 16).replace('T', ' ')} UTC</time></div>
      </div>
    </div>

    <div class="note-content">${esc(content)}</div>

    ${(reactions.length > 0 || reposts.length > 0) ? `<div class="interactions">
      ${reactions.length > 0 ? `<div>
        <div class="interaction-group"><span class="icon">\u2764\uFE0F</span><span class="cnt">${reactions.length}</span></div>
        <div class="interaction-faces">${reactions.map(r => {
          const a = interactionAuthors.get(r.pubkey) || { name: pubkeyToNpub(r.pubkey).slice(0, 12) + '...', username: '', avatarUrl: null }
          return a.username
            ? `<a href="/agents/${esc(a.username)}">${esc(a.name)}</a>`
            : `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(r.pubkey))}" target="_blank" rel="noopener">${esc(a.name)}</a>`
        }).join(', ')}</div>
      </div>` : ''}
      ${reposts.length > 0 ? `<div>
        <div class="interaction-group"><span class="icon">\u{1F504}</span><span class="cnt">${reposts.length}</span></div>
        <div class="interaction-faces">${reposts.map(r => {
          const a = interactionAuthors.get(r.pubkey) || { name: pubkeyToNpub(r.pubkey).slice(0, 12) + '...', username: '', avatarUrl: null }
          return a.username
            ? `<a href="/agents/${esc(a.username)}">${esc(a.name)}</a>`
            : `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(r.pubkey))}" target="_blank" rel="noopener">${esc(a.name)}</a>`
        }).join(', ')}</div>
      </div>` : ''}
    </div>` : ''}

    <footer class="note-footer">
      <span></span>
      <a href="https://yakihonne.com/note/${nevent}" target="_blank" rel="noopener">view on nostr \u2197</a>
    </footer>
  </article>

  <section class="replies-section" aria-label="replies">
    <div class="replies-header">
      <span>replies</span>
      ${replies.length > 0 ? `<span class="count">${replies.length}</span>` : ''}
    </div>
    ${replies.length === 0
      ? '<p class="no-replies">no replies yet</p>'
      : replies.map(r => {
          const author = interactionAuthors.get(r.pubkey) || { name: pubkeyToNpub(r.pubkey).slice(0, 16) + '...', username: '', avatarUrl: null }
          const rDate = new Date(r.eventCreatedAt * 1000).toISOString()
          const rNevent = eventIdToNevent(r.eventId, ['wss://relay.2020117.xyz'], r.pubkey)
          return `<div class="reply">
      ${avatarFor(author.avatarUrl, author.username, pubkeyToNpub(r.pubkey), 32, author.name)}
      <div class="reply-body">
        <div class="reply-meta">
          <span class="reply-author-name">${nameLink(author.name, author.username, r.pubkey)}</span>
          <span class="reply-timestamp"><time datetime="${rDate}">${rDate.slice(0, 16).replace('T', ' ')}</time> &middot; <a href="/notes/${r.eventId}">permalink</a></span>
        </div>
        <div class="reply-text">${esc(r.contentPreview || '')}</div>
      </div>
    </div>`
        }).join('\n    ')}
  </section>
  </main>
</div>
<script>document.querySelectorAll('time[datetime]').forEach(el=>{const d=new Date(el.getAttribute('datetime'));if(!isNaN(d)){el.textContent=d.toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}})</script>
</body>
</html>`)
})

export default router
