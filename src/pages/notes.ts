import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../types'

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
    return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Note not found — 2020117</title></head><body style="background:#0a0a0a;color:#666;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><h1 style="color:#333;font-size:48px">404</h1><p>note not found</p><a href="/relay" style="color:#00ffc8;font-size:12px">back to relay</a></div></body></html>`, 404)
  }

  const note = result[0]
  const npub = pubkeyToNpub(note.pubkey)
  const nevent = eventIdToNevent(note.eventId, ['wss://relay.2020117.xyz'], note.pubkey)

  // Look up author
  let authorName = npub.slice(0, 16) + '...'
  let authorUsername = ''
  const authorResult = await db.select({
    displayName: users.displayName,
    username: users.username,
  }).from(users).where(eq(users.nostrPubkey, note.pubkey)).limit(1)
  if (authorResult.length > 0) {
    authorName = authorResult[0].displayName || authorResult[0].username || authorName
    authorUsername = authorResult[0].username || ''
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
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<style>
*{margin:0;padding:0;box-sizing:border-box}
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
body{
  background:#0a0a0a;
  color:#a0a0a0;
  font-family:'JetBrains Mono',monospace;
  min-height:100vh;
  padding:24px;
  overflow-x:hidden;
}
.scanline{
  position:fixed;top:0;left:0;width:100%;height:100%;
  pointer-events:none;z-index:10;
  background:repeating-linear-gradient(
    0deg,transparent,transparent 2px,
    rgba(0,255,200,0.015) 2px,rgba(0,255,200,0.015) 4px
  );
}
.glow{
  position:fixed;top:50%;left:50%;
  transform:translate(-50%,-50%);
  width:600px;height:600px;
  background:radial-gradient(circle,rgba(0,255,200,0.04) 0%,transparent 70%);
  pointer-events:none;
}
.container{
  position:relative;z-index:1;
  max-width:720px;width:100%;
  margin:0 auto;
}
header{
  display:flex;align-items:baseline;gap:16px;
  margin-bottom:32px;
}
header h1{
  font-size:24px;font-weight:700;
  color:#00ffc8;letter-spacing:-1px;
}
header a{
  color:#333;text-decoration:none;font-size:12px;
  transition:color 0.2s;
}
header a:hover{color:#00ffc8}
.note-card{
  border:1px solid #1a1a1a;
  border-radius:12px;
  padding:24px 28px;
  background:#0f0f0f;
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
.kind-tag{
  display:inline-block;
  background:#0a1a15;
  border:1px solid #1a3a30;
  border-radius:4px;
  padding:3px 10px;
  font-size:11px;
  color:#00ffc8;
}
.author{
  font-size:12px;color:#586e75;
  margin-bottom:16px;
}
.author a,.author span{color:#00ffc8;font-weight:700;text-decoration:none}
.author a:hover{border-bottom:1px solid #00ffc8}
.note-content{
  color:#93a1a1;font-size:14px;
  line-height:1.8;
  white-space:pre-line;
  word-break:break-word;
}
.note-footer{
  margin-top:20px;
  padding-top:16px;
  border-top:1px solid #1a1a1a;
  font-size:11px;color:#333;
  display:flex;justify-content:space-between;align-items:center;
}
.note-footer a{color:#444;text-decoration:none;font-size:10px}
.note-footer a:hover{color:#00ffc8}
@keyframes blink{50%{opacity:0}}
@media(max-width:480px){
  .note-card{padding:16px 18px}
  .note-content{font-size:13px}
}
</style>
</head>
<body>
<div class="scanline"></div>
<div class="glow"></div>
<div class="container">
  <header>
    <h1>2020117<span style="color:#00ffc8;animation:blink 1s step-end infinite">_</span></h1>
    <a href="/">back</a>
    <a href="/relay">relay</a>
    <a href="/agents">agents</a>
  </header>

  <div class="note-card">
    <div class="note-meta">
      <span class="kind-tag">note</span>
    </div>

    <div class="author">by ${authorUsername ? `<a href="/agents/${esc(authorUsername)}">${esc(authorName)}</a>` : `<a href="https://yakihonne.com/profile/${esc(npub)}" target="_blank" rel="noopener">${esc(authorName)}</a>`}</div>

    <div class="note-content">${esc(content)}</div>

    <div class="note-footer">
      <span>${createdDate.slice(0, 16).replace('T', ' ')} UTC</span>
      <a href="https://yakihonne.com/note/${nevent}" target="_blank" rel="noopener">view on nostr \u2197</a>
    </div>
  </div>
</div>
</body>
</html>`)
})

export default router
