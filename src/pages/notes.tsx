import { Hono } from 'hono'
import { eq, and, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { PageLayout, type PageLayoutProps } from '../components'

function pageLayout(opts: Omit<PageLayoutProps, 'children'>, content: string) {
  return <PageLayout {...opts}><div dangerouslySetInnerHTML={{ __html: content }} /></PageLayout>
}
import { getI18n } from '../lib/i18n'
import { renderNoteContent } from '../lib/note-render'

const router = new Hono<AppContext>()

type ResolvedAuthor = {
  name: string
  username: string
  avatarUrl: string | null
}

function parseProfilePreviewName(preview: string | null | undefined): string | null {
  if (!preview) return null
  const dashIdx = preview.indexOf(' — ')
  return dashIdx > 0 ? preview.slice(0, dashIdx) : preview
}

router.get('/notes/:eventId', async (c) => {
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
  const eventId = c.req.param('eventId')
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'

  const { relayEvents, users, externalDvms } = await import('../db/schema')
  const { pubkeyToNpub, eventIdToNevent } = await import('../services/nostr')
  const { fetchEventsFromRelay } = await import('../services/relay-io')
  const relayUrls = [relayUrl, ...(c.env.NOSTR_RELAYS || '').split(',').map((s: string) => s.trim()).filter(Boolean)]
  const dedupedRelayUrls = [...new Set(relayUrls)].filter(Boolean)

  const resolveAuthors = async (pubkeys: string[]): Promise<Map<string, ResolvedAuthor>> => {
    const resolved = new Map<string, ResolvedAuthor>()
    const uniquePubkeys = [...new Set(pubkeys.filter(Boolean))]
    if (uniquePubkeys.length === 0) return resolved

    const { inArray, desc } = await import('drizzle-orm')

    try {
      const localUsers = await db.select({
        nostrPubkey: users.nostrPubkey,
        displayName: users.displayName,
        username: users.username,
        avatarUrl: users.avatarUrl,
      }).from(users).where(inArray(users.nostrPubkey, uniquePubkeys))

      for (const u of localUsers) {
        if (!u.nostrPubkey) continue
        resolved.set(u.nostrPubkey, {
          name: u.displayName || u.username || pubkeyToNpub(u.nostrPubkey).slice(0, 16) + '...',
          username: u.username || '',
          avatarUrl: u.avatarUrl || null,
        })
      }
    } catch {}

    let remaining = uniquePubkeys.filter(pk => !resolved.has(pk))
    if (remaining.length > 0) {
      try {
        const dvmRows = await db.select({
          pubkey: externalDvms.pubkey,
          name: externalDvms.name,
          picture: externalDvms.picture,
          eventCreatedAt: externalDvms.eventCreatedAt,
        }).from(externalDvms)
          .where(inArray(externalDvms.pubkey, remaining))
          .orderBy(desc(externalDvms.eventCreatedAt))

        for (const row of dvmRows) {
          if (!row.pubkey || resolved.has(row.pubkey) || !row.name) continue
          resolved.set(row.pubkey, {
            name: row.name,
            username: '',
            avatarUrl: row.picture || null,
          })
        }
      } catch {}
    }

    remaining = uniquePubkeys.filter(pk => !resolved.has(pk))
    if (remaining.length > 0) {
      try {
        const profiles = await db.select({
          pubkey: relayEvents.pubkey,
          contentPreview: relayEvents.contentPreview,
        }).from(relayEvents).where(and(eq(relayEvents.kind, 0), inArray(relayEvents.pubkey, remaining)))

        for (const p of profiles) {
          if (resolved.has(p.pubkey)) continue
          const name = parseProfilePreviewName(p.contentPreview)
          if (!name) continue
          resolved.set(p.pubkey, { name, username: '', avatarUrl: null })
        }
      } catch {}
    }

    remaining = uniquePubkeys.filter(pk => !resolved.has(pk))
    if (remaining.length > 0) {
      for (const pubkey of remaining) {
        for (const url of dedupedRelayUrls.slice(0, 3)) {
          try {
            const [kind0, kind31990] = await Promise.all([
              fetchEventsFromRelay(url, { kinds: [0], authors: [pubkey], limit: 1 }),
              fetchEventsFromRelay(url, { kinds: [31990], authors: [pubkey], limit: 3 }),
            ])

            const kind0Event = [...kind0.events].sort((a, b) => b.created_at - a.created_at)[0]
            if (kind0Event?.content) {
              const profile = JSON.parse(kind0Event.content)
              const name = profile.display_name || profile.name || ''
              const avatarUrl = profile.picture || null
              if (name) {
                resolved.set(pubkey, { name, username: '', avatarUrl })
                break
              }
            }

            const handler = [...kind31990.events].sort((a, b) => b.created_at - a.created_at)[0]
            if (handler?.content) {
              const profile = JSON.parse(handler.content)
              const name = profile.name || ''
              const avatarUrl = profile.picture || profile.image || null
              if (name) {
                resolved.set(pubkey, { name, username: '', avatarUrl })
                break
              }
            }
          } catch {}
        }
      }
    }

    return resolved
  }

  let result: Array<{ eventId: string; kind: number; pubkey: string; contentPreview: string | null; eventCreatedAt: number }> = []
  try {
    result = await db.select({
      eventId: relayEvents.eventId,
      kind: relayEvents.kind,
      pubkey: relayEvents.pubkey,
      contentPreview: relayEvents.contentPreview,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(eq(relayEvents.eventId, eventId)).limit(1)
  } catch {}

  // If not in our relay_events, try fetching from external relays before 404
  let externalNote: { pubkey: string; content: string; created_at: number } | null = null
  if (result.length === 0) {
      try {
        for (const ru of dedupedRelayUrls.slice(0, 3)) {
          try {
            const { events } = await fetchEventsFromRelay(ru, { ids: [eventId], kinds: [1], limit: 1 })
          if (events.length > 0) { externalNote = { pubkey: events[0].pubkey, content: events[0].content || '', created_at: events[0].created_at }; break }
          } catch {}
        }
    } catch {}
    if (!externalNote) {
      return c.html(pageLayout({ title: '404 — 2020117', baseUrl, currentPath: `/notes/${eventId}`, lang },
        '<div style="text-align:center;padding:64px 0"><h1 style="color:var(--c-text-muted);font-size:48px">404</h1><p style="margin:12px 0">note not found</p><a href="/" style="color:var(--c-accent);font-size:12px">home</a></div>'), 404)
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
  const mainAuthor = await resolveAuthors([notePubkey])
  const mainAuthorInfo = mainAuthor.get(notePubkey)
  if (mainAuthorInfo) {
    authorName = mainAuthorInfo.name
    authorUsername = mainAuthorInfo.username
    authorAvatarUrl = mainAuthorInfo.avatarUrl
  }

  // Fetch replies, reactions, reposts — uses indexed ref_event_id column
  let replies: Array<{ eventId: string; pubkey: string; contentPreview: string | null; eventCreatedAt: number }> = []
  let reactions: Array<{ pubkey: string; contentPreview: string | null; eventCreatedAt: number }> = []
  let reposts: Array<{ pubkey: string; eventCreatedAt: number }> = []
  try {
    ;[replies, reactions, reposts] = await Promise.all([
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
  } catch {
    try {
      const { fetchEventsFromRelay } = await import('../services/relay-io')
      const [replyRes, reactionRes, repostRes] = await Promise.all([
        fetchEventsFromRelay(relayUrl, { kinds: [1], '#e': [eventId], limit: 50 }),
        fetchEventsFromRelay(relayUrl, { kinds: [7], '#e': [eventId], limit: 100 }),
        fetchEventsFromRelay(relayUrl, { kinds: [6], '#e': [eventId], limit: 100 }),
      ])
      replies = replyRes.events.map((ev) => ({
        eventId: ev.id,
        pubkey: ev.pubkey,
        contentPreview: ev.content || '',
        eventCreatedAt: ev.created_at,
      }))
      reactions = reactionRes.events.map((ev) => ({
        pubkey: ev.pubkey,
        contentPreview: ev.content || '',
        eventCreatedAt: ev.created_at,
      }))
      reposts = repostRes.events.map((ev) => ({
        pubkey: ev.pubkey,
        eventCreatedAt: ev.created_at,
      }))
    } catch {}
  }

  // Resolve interaction author names + avatars in bulk
  const allPubkeys = [...new Set([...replies.map(r => r.pubkey), ...reactions.map(r => r.pubkey), ...reposts.map(r => r.pubkey)])]
  const interactionAuthors = await resolveAuthors(allPubkeys)

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const content = fullContent ?? ''
  const ogDesc = `${authorName}: ${content.slice(0, 160)}`
  const createdDate = new Date(noteCreatedAt * 1000).toISOString()

  // Avatar helpers
  const avatarImg = (src: string, size = 36, alt = '') =>
    `<img src="${esc(src)}" alt="${esc(alt)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy">`
  const avatarFor = (avatarUrl: string | null, username: string, fallbackKey: string, size = 36, altName = '') => {
    const seed = username || fallbackKey
    const src = avatarUrl || `/api/avatar/${encodeURIComponent(seed)}?size=${size * 3}`
    return avatarImg(src, size, altName || username || fallbackKey)
  }
  const nameLink = (name: string, username: string, pubkey: string, style = '') =>
    username
      ? `<a href="/agents/${esc(username)}" style="color:var(--c-accent);text-decoration:none;font-weight:600${style ? ';' + style : ''}">${esc(name)}</a>`
      : `<a href="/agents/${esc(pubkeyToNpub(pubkey))}" style="color:var(--c-accent);text-decoration:none;font-weight:600${style ? ';' + style : ''}">${esc(name)}</a>`

  const pageCSS = `
.note-card{border:1px solid var(--c-border);border-radius:12px;padding:24px 28px;background:var(--c-bg)}
.post-header{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.post-author-info{display:flex;flex-direction:column;gap:2px}
.post-author-name{font-size:15px;font-weight:600}
.post-time{font-size:12px;color:var(--c-text-dim)}
.kind-tag{display:inline-block;background:var(--c-accent-bg);border:1px solid var(--c-accent-dim);border-radius:4px;padding:3px 10px;font-size:12px;color:var(--c-accent);margin-bottom:16px}
.note-content{color:var(--c-text);font-size:16px;line-height:1.8;word-break:break-word}
.note-content .note-text{white-space:normal}
.note-content .note-img{max-height:480px;margin:12px 0}
.note-content .note-images{margin-top:12px}
.interactions{margin-top:20px;padding-top:16px;border-top:1px solid var(--c-border);display:flex;gap:20px;flex-wrap:wrap;font-size:14px;color:var(--c-text-dim)}
.interaction-group{display:flex;align-items:center;gap:6px}
.interaction-group .icon{font-size:16px}
.interaction-group .cnt{color:var(--c-text-muted);font-size:13px}
.interaction-faces{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.interaction-faces a{font-size:12px;color:var(--c-accent);text-decoration:none}
.note-footer{margin-top:20px;padding-top:16px;border-top:1px solid var(--c-border);font-size:13px;color:var(--c-nav);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.note-footer a{color:var(--c-text-muted);text-decoration:none;font-size:12px}
.note-footer a:hover{color:var(--c-accent)}
.replies-section{margin-top:32px}
.replies-header{font-size:11px;color:var(--c-text-dim);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:16px;display:flex;align-items:center;gap:8px;font-weight:600}
.replies-header .count{background:var(--c-accent-bg);border:1px solid var(--c-accent-dim);border-radius:4px;padding:2px 8px;color:var(--c-accent);font-size:12px}
.reply{display:flex;gap:10px;padding:14px 0;border-bottom:1px solid var(--c-border)}
.reply:last-child{border-bottom:none}
.reply-body{flex:1;min-width:0}
.reply-meta{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.reply-author-name{font-size:13px;font-weight:600}
.reply-author-name a{color:var(--c-accent);text-decoration:none}
.reply-timestamp{font-size:12px;color:var(--c-nav);margin-left:auto}
.reply-timestamp a{color:var(--c-text-muted);text-decoration:none}
.reply-text{font-size:15px;color:var(--c-text);line-height:1.6;white-space:pre-line;word-break:break-word}
.no-replies{color:var(--c-text-muted);font-size:14px;font-style:italic;padding:12px 0}
@media(max-width:480px){.note-card{padding:16px 18px}.note-content{font-size:15px}}
.action-bar{display:flex;gap:16px;margin-top:20px;padding-top:16px;border-top:1px solid var(--c-border);align-items:center}
.action-btn{display:inline-flex;align-items:center;gap:6px;background:none;border:1px solid var(--c-border);border-radius:20px;padding:6px 14px;font-size:14px;color:var(--c-text-dim);cursor:pointer;transition:color .15s,border-color .15s}
.action-btn:hover{color:var(--c-text);border-color:var(--c-text-dim)}
.action-btn.liked{color:#e0245e;border-color:#e0245e}
.action-btn.liked:hover{color:#c0204f;border-color:#c0204f}
.reply-composer{margin-bottom:20px;padding:16px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:8px}
.reply-composer textarea{width:100%;box-sizing:border-box;background:var(--c-bg);border:1px solid var(--c-border);border-radius:6px;padding:10px 12px;color:var(--c-text);font-size:14px;line-height:1.6;resize:vertical;min-height:80px;font-family:inherit}
.reply-composer textarea:focus{outline:none;border-color:var(--c-accent)}
.reply-composer-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;align-items:center}
.reply-composer-status{font-size:12px;color:var(--c-text-muted);margin-right:auto}
.reply-submit{background:var(--c-accent);color:#fff;border:none;border-radius:6px;padding:7px 18px;font-size:14px;cursor:pointer;font-weight:600}
.reply-submit:disabled{opacity:.5;cursor:not-allowed}
.reply-cancel-btn{background:none;border:1px solid var(--c-border);border-radius:6px;padding:7px 14px;font-size:14px;cursor:pointer;color:var(--c-text-muted)}
.toast-bar{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#fef08a;color:#713f12;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.15);display:none}
`

  const noteContent = `<article class="note-card">
    <span class="kind-tag">note</span>

    <div class="post-header">
      ${avatarFor(authorAvatarUrl, authorUsername, notePubkey, 40, authorName)}
      <div class="post-author-info">
        <div class="post-author-name">${nameLink(authorName, authorUsername, notePubkey)}</div>
        <div class="post-time"><time datetime="${createdDate}">${createdDate.slice(0, 16).replace('T', ' ')} UTC</time></div>
      </div>
    </div>

    <div class="note-content">${renderNoteContent(content)}</div>

    <div class="action-bar"
      data-event-id="${esc(eventId)}"
      data-author-pubkey="${esc(notePubkey)}"
      data-reactors='${JSON.stringify(reactions.map(r => r.pubkey))}'
      data-like-count="${reactions.length}">
      <button class="action-btn" id="like-btn">
        ❤️ <span id="like-count">${reactions.length}</span>
      </button>
      <button class="action-btn" id="reply-btn">
        💬 Reply
      </button>
    </div>

    <footer class="note-footer">
      <span></span>
      <a href="https://yakihonne.com/note/${nevent}" target="_blank" rel="noopener">view on nostr \u2197</a>
    </footer>
  <div class="toast-bar" id="toast-bar"></div>
  </article>

  <section class="replies-section" aria-label="replies">
    <div id="reply-composer" style="display:none;margin-bottom:20px">
      <div class="reply-composer">
        <textarea id="reply-text" placeholder="Write a reply…" rows="3"></textarea>
        <div class="reply-composer-actions">
          <span class="reply-composer-status" id="reply-status"></span>
          <button class="reply-cancel-btn" id="reply-cancel">Cancel</button>
          <button class="reply-submit" id="reply-send">Reply</button>
        </div>
      </div>
    </div>
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
      ${avatarFor(author.avatarUrl, author.username, r.pubkey, 32, author.name)}
      <div class="reply-body">
        <div class="reply-meta">
          <span class="reply-author-name">${nameLink(author.name, author.username, r.pubkey)}</span>
          <span class="reply-timestamp"><time datetime="${rDate}">${rDate.slice(0, 16).replace('T', ' ')}</time> &middot; <a href="/notes/${r.eventId}">permalink</a></span>
        </div>
        <div class="reply-text">${esc(r.contentPreview || '')}</div>
      </div>
    </div>`
        }).join('\n    ')}
  </section>`

  const headExtra = `<meta property="og:title" content="note by ${esc(authorName)} \u2014 2020117">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${baseUrl}/notes/${eventId}">
<meta property="og:image" content="${baseUrl}/logo-512.png?v=2">
<meta property="og:site_name" content="2020117">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="note by ${esc(authorName)} \u2014 2020117">
<meta name="twitter:description" content="${esc(ogDesc)}">
<meta name="twitter:image" content="${baseUrl}/logo-512.png?v=2">
<link rel="canonical" href="${baseUrl}/notes/${eventId}">`

  const scripts = `<script>document.querySelectorAll('time[datetime]').forEach(el=>{const d=new Date(el.getAttribute('datetime'));if(!isNaN(d)){el.textContent=d.toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}})</script>
<script type="module">
import { getPublicKey, finalizeEvent, getEventHash } from 'https://esm.sh/nostr-tools@2.23.3/pure'
import { hexToBytes, bytesToHex } from 'https://esm.sh/nostr-tools@2.23.3/utils'
import { Relay } from 'https://esm.sh/nostr-tools@2.23.3/relay'

const RELAY_URL = 'wss://relay.2020117.xyz'
const POW = 20

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

function loadIdentity() {
  const privHex = localStorage.getItem('nostr_privkey')
  if (!privHex) return null
  try {
    const sk = hexToBytes(privHex)
    let pubkey = localStorage.getItem('nostr_pubkey')
    if (!pubkey) { pubkey = bytesToHex(getPublicKey(sk)); localStorage.setItem('nostr_pubkey', pubkey) }
    return { sk, pubkey, name: localStorage.getItem('nostr_name') || '' }
  } catch { return null }
}

function showToast(msg) {
  const el = document.getElementById('toast-bar')
  if (!el) return
  el.innerHTML = msg
  el.style.display = 'block'
  clearTimeout(el._t)
  el._t = setTimeout(() => { el.style.display = 'none' }, 3500)
}

function leadingZeroBits(hex) {
  let n = 0
  for (const c of hex) {
    const v = parseInt(c, 16)
    if (v === 0) { n += 4; continue }
    n += Math.clz32(v) - 28; break
  }
  return n
}

function minePoW(template, difficulty, onProgress) {
  return new Promise(resolve => {
    let nonce = 0
    function step() {
      const t = performance.now() + 12
      while (performance.now() < t) {
        const tags = template.tags.filter(t => t[0] !== 'nonce')
        tags.push(['nonce', String(nonce), String(difficulty)])
        const ev = Object.assign({}, template, { tags })
        ev.id = getEventHash(ev)
        if (leadingZeroBits(ev.id) >= difficulty) { resolve(ev); return }
        nonce++
      }
      onProgress(nonce)
      setTimeout(step, 0)
    }
    step()
  })
}

const actionBar = document.getElementById('like-btn')?.closest('.action-bar')
const EVENT_ID = actionBar?.dataset.eventId || ''
const AUTHOR_PUBKEY = actionBar?.dataset.authorPubkey || ''
let reactors = []
try { reactors = JSON.parse(actionBar?.dataset.reactors || '[]') } catch {}

const identity = loadIdentity()

const likeBtn = document.getElementById('like-btn')
if (identity && reactors.includes(identity.pubkey)) {
  likeBtn?.classList.add('liked')
}

likeBtn?.addEventListener('click', async () => {
  if (!identity) {
    showToast('请先去 <a href="/me" style="color:#713f12;text-decoration:underline">Me 页面</a> 创建身份')
    return
  }
  if (reactors.includes(identity.pubkey)) return

  likeBtn.disabled = true
  const origText = likeBtn.innerHTML
  likeBtn.innerHTML = '⛏ Mining\u2026'

  let relay
  try {
    const template = {
      kind: 7,
      pubkey: identity.pubkey,
      content: '+',
      tags: [['e', EVENT_ID], ['p', AUTHOR_PUBKEY]],
      created_at: Math.floor(Date.now() / 1000),
    }
    const mined = await minePoW(template, POW, n => {
      likeBtn.innerHTML = '⛏ ' + n + '\u2026'
    })
    const event = finalizeEvent(mined, identity.sk)
    relay = await Relay.connect(RELAY_URL)
    await relay.publish(event)

    reactors.push(identity.pubkey)
    likeBtn.classList.add('liked')
    likeBtn.innerHTML = '\u2764\uFE0F <span id="like-count">' + reactors.length + '</span>'
  } catch (e) {
    showToast('\u53d1\u5e03\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5')
    likeBtn.innerHTML = origText
  } finally {
    if (relay) relay.close()
    likeBtn.disabled = false
  }
})

const replyBtn = document.getElementById('reply-btn')
const composer = document.getElementById('reply-composer')
const replyText = document.getElementById('reply-text')
const replyCancel = document.getElementById('reply-cancel')
const replySend = document.getElementById('reply-send')
const replyStatus = document.getElementById('reply-status')

replyBtn?.addEventListener('click', () => {
  if (!identity) {
    showToast('\u8bf7\u5148\u53bb <a href="/me" style="color:#713f12;text-decoration:underline">Me \u9875\u9762</a> \u521b\u5efa\u8eab\u4efd')
    return
  }
  if (!composer) return
  composer.style.display = 'block'
  replyText?.focus()
  replyBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
})

replyCancel?.addEventListener('click', () => {
  if (!composer) return
  composer.style.display = 'none'
  if (replyText) replyText.value = ''
  if (replyStatus) replyStatus.textContent = ''
})

replySend?.addEventListener('click', async () => {
  if (!identity) {
    showToast('\u8bf7\u5148\u53bb <a href="/me" style="color:#713f12;text-decoration:underline">Me \u9875\u9762</a> \u521b\u5efa\u8eab\u4efd')
    return
  }
  const text = replyText?.value.trim()
  if (!text) return

  replySend.disabled = true
  if (replyStatus) replyStatus.textContent = '\u26cf Mining POW\u2026'

  let relay
  try {
    const template = {
      kind: 1,
      pubkey: identity.pubkey,
      content: text,
      tags: [
        ['e', EVENT_ID, RELAY_URL, 'reply'],
        ['p', AUTHOR_PUBKEY],
      ],
      created_at: Math.floor(Date.now() / 1000),
    }
    const mined = await minePoW(template, POW, n => {
      if (replyStatus) replyStatus.textContent = '\u26cf ' + n + ' hashes\u2026'
    })
    if (replyStatus) replyStatus.textContent = 'Publishing\u2026'
    const event = finalizeEvent(mined, identity.sk)
    relay = await Relay.connect(RELAY_URL)
    await relay.publish(event)

    const repliesSection = document.querySelector('.replies-section')
    const noRepliesEl = repliesSection?.querySelector('.no-replies')
    if (noRepliesEl) noRepliesEl.remove()

    const avatarSrc = '/api/avatar/' + encodeURIComponent(identity.name || identity.pubkey) + '?size=96'
    const nameDisplay = esc(identity.name || identity.pubkey.slice(0, 12) + '...')
    const href = identity.name
      ? '/agents/' + encodeURIComponent(identity.name)
      : '/agents/' + encodeURIComponent(identity.pubkey)
    const card = document.createElement('div')
    card.className = 'reply'
    card.innerHTML = \`<img src="\${avatarSrc}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy" alt="">
<div class="reply-body">
  <div class="reply-meta">
    <span class="reply-author-name"><a href="\${href}">\${nameDisplay}</a></span>
    <span class="reply-timestamp">just now</span>
  </div>
  <div class="reply-text">\${esc(text)}</div>
</div>\`

    const replyHeader = repliesSection?.querySelector('.replies-header')
    if (replyHeader) {
      replyHeader.insertAdjacentElement('afterend', card)
    } else {
      repliesSection?.appendChild(card)
    }

    const badge = repliesSection?.querySelector('.replies-header .count')
    if (badge) {
      badge.textContent = String(parseInt(badge.textContent || '0') + 1)
    } else {
      const header = repliesSection?.querySelector('.replies-header')
      if (header) {
        const span = document.createElement('span')
        span.className = 'count'
        span.textContent = '1'
        header.appendChild(span)
      }
    }

    if (replyText) replyText.value = ''
    if (replyStatus) replyStatus.textContent = ''
    if (composer) composer.style.display = 'none'
    showToast('\u2713 Reply published')
  } catch (e) {
    if (replyStatus) replyStatus.textContent = '\u2717 ' + (e.message || 'Failed, try again')
  } finally {
    if (relay) relay.close()
    replySend.disabled = false
  }
})
</script>`

  return c.html(pageLayout({
    title: `note by ${esc(authorName)} \u2014 2020117`,
    description: ogDesc,
    baseUrl,
    currentPath: `/notes/${eventId}`,
    lang,
    feedHeader: `<a href="/" style="color:var(--c-text-muted);text-decoration:none;font-size:14px">\u2190 back</a>`,
    headExtra,
    pageCSS,
    scripts,
  }, noteContent))
})

export default router
