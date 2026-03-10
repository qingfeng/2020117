import { Hono } from 'hono'
import { eq, and, sql } from 'drizzle-orm'
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

  // Fetch replies (Kind 1), reactions (Kind 7), reposts (Kind 6) referencing this event
  const [localReplies, localReactions, localReposts] = await Promise.all([
    db.select({
      eventId: relayEvents.eventId,
      pubkey: relayEvents.pubkey,
      contentPreview: relayEvents.contentPreview,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(
      and(eq(relayEvents.kind, 1), sql`instr(${relayEvents.tags}, ${eventId}) > 0`)
    ).orderBy(relayEvents.eventCreatedAt).limit(50),
    db.select({
      pubkey: relayEvents.pubkey,
      contentPreview: relayEvents.contentPreview,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(
      and(eq(relayEvents.kind, 7), sql`instr(${relayEvents.tags}, ${eventId}) > 0`)
    ).orderBy(relayEvents.eventCreatedAt).limit(100),
    db.select({
      pubkey: relayEvents.pubkey,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(
      and(eq(relayEvents.kind, 6), sql`instr(${relayEvents.tags}, ${eventId}) > 0`)
    ).orderBy(relayEvents.eventCreatedAt).limit(100),
  ])

  // If local DB lacks interactions, fetch from public relays and cache
  let replies = localReplies
  let reactions = localReactions as { pubkey: string; contentPreview: string | null; eventCreatedAt: number }[]
  let reposts = localReposts as { pubkey: string; eventCreatedAt: number }[]

  if (localReactions.length === 0 || localReposts.length === 0 || localReplies.length === 0) {
    try {
      const { fetchEventsFromRelay } = await import('../services/relay-io')
      const { generateId } = await import('../lib/utils')
      const relayUrls = (c.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol').split(',').map((s: string) => s.trim()).filter(Boolean)

      // Fetch Kind 1 (replies), 7 (reactions), 6 (reposts) referencing this event
      const kindsToFetch: number[] = []
      if (localReplies.length === 0) kindsToFetch.push(1)
      if (localReactions.length === 0) kindsToFetch.push(7)
      if (localReposts.length === 0) kindsToFetch.push(6)

      const seenIds = new Set<string>()
      for (const relayUrl of relayUrls.slice(0, 3)) {
        try {
          const { events } = await fetchEventsFromRelay(relayUrl, {
            kinds: kindsToFetch, '#e': [eventId], limit: 100,
          })
          for (const ev of events) {
            if (seenIds.has(ev.id)) continue
            seenIds.add(ev.id)
            // Cache to relay_event
            const eTags: Record<string, string> = {}
            for (const tag of ev.tags) {
              if (tag[0] === 'e') eTags.e = tag[1] || ''
              if (tag[0] === 'p') eTags.p = tag[1] || ''
            }
            try {
              await db.insert(relayEvents).values({
                id: generateId(), eventId: ev.id, kind: ev.kind,
                pubkey: ev.pubkey,
                contentPreview: ev.kind === 7 ? (ev.content || '+') : (ev.kind === 1 ? ev.content?.slice(0, 200) || null : null),
                tags: JSON.stringify(eTags),
                eventCreatedAt: ev.created_at, createdAt: new Date(),
              }).onConflictDoNothing()
            } catch { /* already exists */ }

            if (ev.kind === 1 && localReplies.length === 0) {
              (replies as any[]).push({ eventId: ev.id, pubkey: ev.pubkey, contentPreview: ev.content?.slice(0, 200) || '', eventCreatedAt: ev.created_at })
            } else if (ev.kind === 7) {
              (reactions as any[]).push({ pubkey: ev.pubkey, contentPreview: ev.content || '+', eventCreatedAt: ev.created_at })
            } else if (ev.kind === 6) {
              (reposts as any[]).push({ pubkey: ev.pubkey, eventCreatedAt: ev.created_at })
            }
          }
        } catch { /* relay unavailable, continue */ }
      }
      // Sort and deduplicate
      replies.sort((a, b) => a.eventCreatedAt - b.eventCreatedAt)
      reactions = [...new Map(reactions.map(r => [r.pubkey, r])).values()]
      reposts = [...new Map(reposts.map(r => [r.pubkey, r])).values()]
    } catch { /* non-critical */ }
  }

  // Resolve all interaction author names in bulk
  const allPubkeys = [...new Set([
    ...replies.map(r => r.pubkey),
    ...reactions.map(r => r.pubkey),
    ...reposts.map(r => r.pubkey),
  ])]
  const interactionAuthors = new Map<string, { name: string; username: string }>()
  if (allPubkeys.length > 0) {
    const { inArray } = await import('drizzle-orm')
    const localUsers = await db.select({
      nostrPubkey: users.nostrPubkey,
      displayName: users.displayName,
      username: users.username,
    }).from(users).where(inArray(users.nostrPubkey, allPubkeys))
    for (const u of localUsers) {
      if (u.nostrPubkey) {
        interactionAuthors.set(u.nostrPubkey, {
          name: u.displayName || u.username || pubkeyToNpub(u.nostrPubkey).slice(0, 16) + '...',
          username: u.username || '',
        })
      }
    }
    const remaining = allPubkeys.filter(pk => !interactionAuthors.has(pk))
    if (remaining.length > 0) {
      const profiles = await db.select({
        pubkey: relayEvents.pubkey,
        contentPreview: relayEvents.contentPreview,
      }).from(relayEvents).where(and(eq(relayEvents.kind, 0), inArray(relayEvents.pubkey, remaining)))
      for (const p of profiles) {
        if (p.contentPreview) {
          const dashIdx = p.contentPreview.indexOf(' — ')
          const name = dashIdx > 0 ? p.contentPreview.slice(0, dashIdx) : p.contentPreview
          interactionAuthors.set(p.pubkey, { name, username: '' })
        }
      }
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
  font-size:14px;color:var(--c-text-dim);
  margin-bottom:16px;
}
.author a,.author span{color:var(--c-accent);font-weight:700;text-decoration:none}
.author a:hover{border-bottom:1px solid var(--c-accent)}
.note-content{
  color:#93a1a1;font-size:16px;
  line-height:1.8;
  white-space:pre-line;
  word-break:break-word;
}
.note-footer{
  margin-top:20px;
  padding-top:16px;
  border-top:1px solid var(--c-border);
  font-size:13px;color:var(--c-nav);
  display:flex;justify-content:space-between;align-items:center;
}
.note-footer a{color:var(--c-text-muted);text-decoration:none;font-size:12px}
.note-footer a:hover{color:var(--c-accent)}
.replies-section{margin-top:32px}
.replies-header{
  font-size:12px;color:var(--c-text-muted);
  text-transform:uppercase;letter-spacing:1.5px;
  margin-bottom:16px;
  display:flex;align-items:center;gap:8px;
}
.replies-header .count{
  background:var(--c-accent-bg);border:1px solid var(--c-accent-dim);
  border-radius:4px;padding:2px 8px;
  color:var(--c-accent);font-size:12px;
}
.reply{
  border-left:2px solid var(--c-border);
  padding:12px 0 12px 16px;
  margin-bottom:4px;
}
.reply:last-child{margin-bottom:0}
.reply:hover{border-left-color:var(--c-accent-dim)}
.reply-author{
  font-size:13px;color:var(--c-text-dim);margin-bottom:6px;
}
.reply-author a{color:var(--c-accent);text-decoration:none;font-weight:700}
.reply-author a:hover{border-bottom:1px solid var(--c-accent)}
.reply-content{
  font-size:15px;color:var(--c-text);
  line-height:1.6;white-space:pre-line;word-break:break-word;
}
.reply-time{
  font-size:12px;color:var(--c-nav);margin-top:6px;
}
.reply-time a{color:var(--c-text-muted);text-decoration:none}
.reply-time a:hover{color:var(--c-accent)}
.no-replies{
  color:var(--c-text-muted);font-size:14px;font-style:italic;
  padding:12px 0;
}
.interactions{
  margin-top:20px;padding:12px 0;
  border-top:1px solid var(--c-border);
  display:flex;gap:20px;flex-wrap:wrap;
  font-size:14px;color:var(--c-text-dim);
}
.interaction-group{display:flex;align-items:center;gap:6px}
.interaction-group .icon{font-size:16px}
.interaction-group .label{color:var(--c-text-muted);font-size:13px}
.interaction-faces{
  display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;
}
.interaction-faces a,.interaction-faces span{
  font-size:12px;color:var(--c-accent);text-decoration:none;
}
.interaction-faces a:hover{border-bottom:1px solid var(--c-accent)}
@media(max-width:480px){
  .note-card{padding:16px 18px}
  .note-content{font-size:15px}
  .reply{padding-left:12px}
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

    ${(reactions.length > 0 || reposts.length > 0) ? `<div class="interactions">
      ${reactions.length > 0 ? `<div class="interaction-group">
        <span class="icon">\u2764\uFE0F</span>
        <span class="label">${reactions.length}</span>
        <div class="interaction-faces">${reactions.map(r => {
          const a = interactionAuthors.get(r.pubkey) || { name: pubkeyToNpub(r.pubkey).slice(0, 12) + '...', username: '' }
          return a.username
            ? `<a href="/agents/${esc(a.username)}">${esc(a.name)}</a>`
            : `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(r.pubkey))}" target="_blank" rel="noopener noreferrer">${esc(a.name)}</a>`
        }).join(', ')}</div>
      </div>` : ''}
      ${reposts.length > 0 ? `<div class="interaction-group">
        <span class="icon">\u{1F504}</span>
        <span class="label">${reposts.length}</span>
        <div class="interaction-faces">${reposts.map(r => {
          const a = interactionAuthors.get(r.pubkey) || { name: pubkeyToNpub(r.pubkey).slice(0, 12) + '...', username: '' }
          return a.username
            ? `<a href="/agents/${esc(a.username)}">${esc(a.name)}</a>`
            : `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(r.pubkey))}" target="_blank" rel="noopener noreferrer">${esc(a.name)}</a>`
        }).join(', ')}</div>
      </div>` : ''}
    </div>` : ''}

    <footer class="note-footer">
      <time datetime="${createdDate}">${createdDate.slice(0, 16).replace('T', ' ')} UTC</time>
      <a href="https://yakihonne.com/note/${nevent}" target="_blank" rel="noopener noreferrer">view on nostr \u2197</a>
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
          const author = interactionAuthors.get(r.pubkey) || { name: pubkeyToNpub(r.pubkey).slice(0, 16) + '...', username: '' }
          const rDate = new Date(r.eventCreatedAt * 1000).toISOString()
          const rNevent = eventIdToNevent(r.eventId, ['wss://relay.2020117.xyz'], r.pubkey)
          return `<div class="reply">
      <div class="reply-author">${author.username
        ? `<a href="/agents/${esc(author.username)}">${esc(author.name)}</a>`
        : `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(r.pubkey))}" target="_blank" rel="noopener noreferrer">${esc(author.name)}</a>`
      }</div>
      <div class="reply-content">${esc(r.contentPreview || '')}</div>
      <div class="reply-time"><time datetime="${rDate}">${rDate.slice(0, 16).replace('T', ' ')} UTC</time> \u00B7 <a href="/notes/${r.eventId}">permalink</a> \u00B7 <a href="https://yakihonne.com/note/${rNevent}" target="_blank" rel="noopener noreferrer">nostr \u2197</a></div>
    </div>`
        }).join('\n    ')}
  </section>
  </main>
</div>
</body>
</html>`)
})

export default router
