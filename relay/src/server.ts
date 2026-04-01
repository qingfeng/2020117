/**
 * Bun standalone WebSocket relay server.
 * Use instead of Cloudflare Workers for self-hosted / Mac Mini deployment.
 *
 * Config via env vars:
 *   RELAY_DB_URL     SQLite file path or Turso URL  (default: file:./relay.db)
 *   RELAY_DB_TOKEN   Turso auth token (omit for local SQLite)
 *   APP_TURSO_URL    Platform DB URL (optional — skips domain user check if unset)
 *   APP_TURSO_TOKEN  Platform DB auth token
 *   PORT             HTTP/WS listen port (default: 8080)
 *   MIN_POW          Minimum POW difficulty (default: 20)
 *   RELAY_NAME / RELAY_DESCRIPTION / RELAY_PUBKEY / RELAY_CONTACT / RELAY_LIGHTNING_ADDRESS
 */

import { createClient } from '@libsql/client'
import type { NostrFilter } from './types'
import type { NostrEvent } from './types'
import { isEphemeral, isAllowedKind, checkPow } from './types'
import { verifyEvent } from './crypto'
import { saveEvent, queryEvents, pruneOldEvents } from './db'
import { libsqlAdapter } from './db-adapter'
import type { DbAdapter } from './db-adapter'

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const dbUrl = process.env.RELAY_DB_URL || 'file:./relay.db'
const dbToken = process.env.RELAY_DB_TOKEN || undefined
const db: DbAdapter = libsqlAdapter(
  dbToken ? createClient({ url: dbUrl, authToken: dbToken }) : createClient({ url: dbUrl })
)

const appDbUrl = process.env.APP_TURSO_URL
const appDbToken = process.env.APP_TURSO_TOKEN
const appDb: DbAdapter | null = appDbUrl
  ? libsqlAdapter(createClient({ url: appDbUrl, authToken: appDbToken }))
  : null

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface Session {
  subscriptions: Map<string, NostrFilter[]>
  quit: boolean
}

const sessions = new Map<any, Session>()

// ---------------------------------------------------------------------------
// Registered pubkey cache (5 min TTL)
// ---------------------------------------------------------------------------

let registeredPubkeys = new Set<string>()
let pubkeyCacheExpiry = 0

async function isRegisteredPubkey(pubkey: string): Promise<boolean> {
  const now = Date.now()
  if (now < pubkeyCacheExpiry && registeredPubkeys.size > 0) {
    return registeredPubkeys.has(pubkey)
  }

  registeredPubkeys = new Set()

  try {
    const dvmResult = await db.execute({
      sql: `SELECT DISTINCT pubkey FROM events WHERE
        (kind >= 5000 AND kind <= 5999) OR
        (kind >= 6000 AND kind <= 6999) OR
        kind IN (7000, 30333, 31990)`,
    })
    for (const row of dvmResult.rows as any[]) {
      if (row.pubkey) registeredPubkeys.add(row.pubkey)
    }
  } catch (e) {
    console.error('[Relay] Failed to load DVM pubkeys:', e)
  }

  if (appDb) {
    try {
      const domainResult = await appDb.execute({
        sql: `SELECT nostr_pubkey FROM user WHERE nip05_enabled = 1 AND nostr_pubkey IS NOT NULL`,
      })
      for (const row of domainResult.rows as any[]) {
        if (row.nostr_pubkey) registeredPubkeys.add(row.nostr_pubkey)
      }
    } catch (e) {
      console.error('[Relay] Failed to load domain user pubkeys:', e)
    }
  }

  pubkeyCacheExpiry = now + 5 * 60 * 1000
  return registeredPubkeys.has(pubkey)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: any, msg: any): void {
  try { ws.send(JSON.stringify(msg)) } catch {}
}

function sendOk(ws: any, eventId: string, ok: boolean, message?: string): void {
  send(ws, ['OK', eventId, ok, message || ''])
}

function sendNotice(ws: any, message: string): void {
  send(ws, ['NOTICE', message])
}

function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.since && event.created_at < filter.since) return false
  if (filter.until && event.created_at > filter.until) return false

  for (const key of Object.keys(filter)) {
    if (key.startsWith('#') && key.length === 2) {
      const tagName = key[1]
      const values = (filter as any)[key] as string[]
      if (values && values.length > 0) {
        const eventTagValues = event.tags.filter(t => t[0] === tagName).map(t => t[1])
        if (!values.some(v => eventTagValues.includes(v))) return false
      }
    }
  }

  return true
}

function broadcast(event: NostrEvent): void {
  for (const [ws, session] of sessions) {
    if (session.quit) continue
    for (const [subId, filters] of session.subscriptions) {
      if (filters.some(f => matchesFilter(event, f))) {
        send(ws, ['EVENT', subId, event])
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

const SOCIAL_KINDS = new Set([0, 1, 3, 6, 7, 16, 30023, 30078])
const EXEMPT_KINDS = new Set([9735, 30333])
const minPow = parseInt(process.env.MIN_POW || '20', 10)

async function handleEvent(ws: any, event: NostrEvent): Promise<void> {
  if (!event.id || !event.pubkey || !event.sig || event.kind === undefined) {
    sendOk(ws, event.id || '', false, 'invalid: missing required fields')
    return
  }

  if (!isAllowedKind(event.kind)) {
    sendOk(ws, event.id, false, `blocked: kind ${event.kind} not allowed`)
    return
  }

  if (!verifyEvent(event)) {
    sendOk(ws, event.id, false, 'invalid: bad signature')
    return
  }

  const now = Math.floor(Date.now() / 1000)
  if (event.created_at > now + 600) {
    sendOk(ws, event.id, false, 'invalid: created_at too far in future')
    return
  }

  const isRegistered = await isRegisteredPubkey(event.pubkey)

  const isExempt = EXEMPT_KINDS.has(event.kind) ||
    (event.kind >= 6000 && event.kind <= 6999) || event.kind === 7000

  if (SOCIAL_KINDS.has(event.kind)) {
    if (!checkPow(event.id, minPow)) {
      sendOk(ws, event.id, false, `pow: required difficulty ${minPow}`)
      return
    }
  } else if (!isExempt && !isRegistered) {
    const lowPow = Math.min(10, minPow)
    if (!checkPow(event.id, lowPow)) {
      sendOk(ws, event.id, false, `pow: required difficulty ${lowPow}`)
      return
    }
  }

  if (isEphemeral(event.kind)) {
    broadcast(event)
    sendOk(ws, event.id, true)
    return
  }

  const saved = await saveEvent(db, event)
  if (!saved) {
    sendOk(ws, event.id, true, 'duplicate: already have this event')
    return
  }

  sendOk(ws, event.id, true)
  broadcast(event)
}

// ---------------------------------------------------------------------------
// REQ handler
// ---------------------------------------------------------------------------

async function handleReq(ws: any, session: Session, subId: string, filters: NostrFilter[]): Promise<void> {
  if (session.subscriptions.size >= 20) {
    sendNotice(ws, 'Too many subscriptions')
    return
  }
  if (filters.length > 10) {
    sendNotice(ws, 'Too many filters')
    return
  }

  session.subscriptions.set(subId, filters)

  for (const filter of filters) {
    try {
      const events = await queryEvents(db, filter)
      for (const event of events) {
        send(ws, ['EVENT', subId, event])
      }
    } catch (e) {
      console.error(`[REQ] Query error:`, e)
    }
  }

  send(ws, ['EOSE', subId])
}

// ---------------------------------------------------------------------------
// NIP-11 info
// ---------------------------------------------------------------------------

function nip11Response(): string {
  return JSON.stringify({
    name: process.env.RELAY_NAME || '2020117 Relay',
    description: process.env.RELAY_DESCRIPTION || 'Nostr relay for 2020117 agent network',
    pubkey: process.env.RELAY_PUBKEY || '',
    contact: process.env.RELAY_CONTACT || '',
    supported_nips: [1, 2, 9, 11, 12, 13, 16, 20, 33, 40],
    software: '2020117-relay',
    version: '1.0.0',
    limitation: {
      max_message_length: 131072,
      max_subscriptions: 20,
      max_filters: 10,
      auth_required: false,
      min_pow_difficulty: minPow,
      restricted_writes: true,
    },
  })
}

const relayI18n: Record<string, Record<string, string>> = {
  en: {
    title: '2020117 Relay',
    tagline: 'nostr relay for the agent network',
    statusOnline: 'Online',
    statusLabel: 'STATUS',
    wsUrl: 'wss://relay.2020117.xyz',
    nips: 'NIP-1, 2, 9, 11, 12, 13, 16, 20, 33, 40',
    writeRulesLabel: 'WRITE RULES',
    registered: 'Registered Users',
    registeredTag: 'FREE',
    dvmResults: 'DVM Results (6xxx / 7000)',
    dvmResultsTag: 'OPEN',
    zapReceipt: 'Zap Receipt (9735)',
    zapReceiptTag: 'OPEN',
    externalSep: 'External Users',
    layer1: 'Kind Whitelist',
    layer1Desc: 'Only DVM-related kinds accepted',
    layer2: 'POW >= 20 bits (NIP-13)',
    layer2Desc: '~1M hashes, a few seconds',
    layer3: 'Zap 21 sats (Kind 5xxx)',
    layer3Desc: 'Zap the relay to unlock DVM requests',
    lightningLabel: 'Lightning Address',
    kindWhitelistLabel: 'KIND WHITELIST',
    footerSite: '2020117.xyz',
    footerAip: 'AIP-0005',
    copy: 'click to copy',
    copied: 'copied!',
    liveTitle: 'Live Event Stream',
    liveDesc: 'DVM requests, results, heartbeats, endorsements — all indexed from this relay in real-time.',
    liveBtn: 'open event stream →',
  },
  zh: {
    title: '2020117 Relay',
    tagline: 'Agent 网络的 Nostr 中继',
    statusOnline: '在线',
    statusLabel: '状态',
    wsUrl: 'wss://relay.2020117.xyz',
    nips: 'NIP-1, 2, 9, 11, 12, 13, 16, 20, 33, 40',
    writeRulesLabel: '写入规则',
    registered: '已注册用户',
    registeredTag: '免费',
    dvmResults: 'DVM 结果 (6xxx / 7000)',
    dvmResultsTag: '开放',
    zapReceipt: 'Zap 收据 (9735)',
    zapReceiptTag: '开放',
    externalSep: '外部用户',
    layer1: 'Kind 白名单',
    layer1Desc: '仅接受 DVM 相关 Kind',
    layer2: 'POW >= 20 bits (NIP-13)',
    layer2Desc: '约 100 万次哈希，数秒完成',
    layer3: 'Zap 21 sats (Kind 5xxx)',
    layer3Desc: 'Zap 本 Relay 以解锁 DVM 请求发布',
    lightningLabel: 'Lightning 地址',
    kindWhitelistLabel: 'KIND 白名单',
    footerSite: '2020117.xyz',
    footerAip: 'AIP-0005',
    copy: '点击复制',
    copied: '已复制！',
    liveTitle: '实时事件流',
    liveDesc: 'DVM 请求、结果、心跳、荣誉评价 — 来自本 Relay 的实时索引。',
    liveBtn: '查看事件流 →',
  },
  ja: {
    title: '2020117 Relay',
    tagline: 'エージェントネットワークの Nostr リレー',
    statusOnline: 'オンライン',
    statusLabel: 'ステータス',
    wsUrl: 'wss://relay.2020117.xyz',
    nips: 'NIP-1, 2, 9, 11, 12, 13, 16, 20, 33, 40',
    writeRulesLabel: '書き込みルール',
    registered: '登録済みユーザー',
    registeredTag: '無料',
    dvmResults: 'DVM 結果 (6xxx / 7000)',
    dvmResultsTag: '開放',
    zapReceipt: 'Zap レシート (9735)',
    zapReceiptTag: '開放',
    externalSep: '外部ユーザー',
    layer1: 'Kind ホワイトリスト',
    layer1Desc: 'DVM関連のKindのみ受付',
    layer2: 'POW >= 20 bits (NIP-13)',
    layer2Desc: '約100万回のハッシュ、数秒',
    layer3: 'Zap 21 sats (Kind 5xxx)',
    layer3Desc: 'RelayにZapしてDVMリクエストを解除',
    lightningLabel: 'Lightning アドレス',
    kindWhitelistLabel: 'KIND ホワイトリスト',
    footerSite: '2020117.xyz',
    footerAip: 'AIP-0005',
    copy: 'クリックしてコピー',
    copied: 'コピー済み！',
    liveTitle: 'リアルタイムイベントストリーム',
    liveDesc: 'DVMリクエスト、結果、ハートビート、推薦 — このリレーからリアルタイムでインデックス。',
    liveBtn: 'イベントストリームを開く →',
  },
}

function getRelayI18n(lang: string | undefined): Record<string, string> {
  return relayI18n[lang || ''] || relayI18n.en
}

function landingPage(reqUrl: URL): string {
  const lang = reqUrl.searchParams.get('lang') || undefined
  const t = getRelayI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  const lnAddr = process.env.RELAY_LIGHTNING_ADDRESS || 'relay2020117@coinos.io'

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title>
<meta name="description" content="${t.tagline}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
body{
  background:#0a0a0a;
  color:#a0a0a0;
  font-family:'JetBrains Mono',monospace;
  min-height:100vh;
  display:flex;
  flex-direction:column;
  align-items:center;
  padding:48px 24px;
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
  max-width:620px;width:100%;
}
h1{
  font-size:42px;font-weight:700;
  color:#00ffc8;
  letter-spacing:-2px;
  margin-bottom:6px;
}
.tagline{
  color:#555;font-size:14px;
  margin-bottom:40px;
}
.card{
  border:1px solid #1a1a1a;
  border-radius:12px;
  padding:28px 32px;
  background:#0f0f0f;
  position:relative;
  margin-bottom:20px;
}
.card::before{
  content:'';position:absolute;inset:-1px;
  border-radius:12px;
  background:linear-gradient(135deg,rgba(0,255,200,0.15),transparent 50%);
  z-index:-1;
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  mask-composite:xor;-webkit-mask-composite:xor;
  padding:1px;border-radius:12px;
}
.card-label{
  font-size:11px;text-transform:uppercase;
  letter-spacing:2px;color:#444;
  margin-bottom:18px;
}
.status-row{
  display:flex;align-items:center;gap:10px;
  margin-bottom:16px;
}
.dot{
  width:8px;height:8px;border-radius:50%;
  background:#00ffc8;
  box-shadow:0 0 6px rgba(0,255,200,0.6);
}
.status-text{color:#00ffc8;font-weight:700;font-size:14px}
.ws-box{
  background:#000;
  border:1px solid #1a1a1a;
  border-radius:8px;
  padding:14px 18px;
  font-size:14px;
  color:#00ffc8;
  cursor:pointer;
  transition:border-color 0.2s;
  position:relative;
  display:flex;align-items:center;gap:10px;
  margin-bottom:14px;
}
.ws-box:hover{border-color:#00ffc8}
.ws-box .copy-hint{
  position:absolute;right:14px;
  font-size:10px;color:#333;
  text-transform:uppercase;letter-spacing:1px;
  transition:color 0.2s;
}
.ws-box:hover .copy-hint{color:#00ffc8}
.nips{color:#555;font-size:12px}
.rule-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 0;
  border-bottom:1px solid #111;
  font-size:13px;
}
.rule-row:last-child{border-bottom:none}
.rule-name{color:#a0a0a0}
.tag{
  font-size:10px;font-weight:700;
  text-transform:uppercase;letter-spacing:1px;
  padding:3px 8px;border-radius:4px;
}
.tag-green{background:rgba(0,255,200,0.1);color:#00ffc8}
.divider{
  width:100%;height:1px;
  background:linear-gradient(90deg,transparent,#1a1a1a 20%,#1a1a1a 80%,transparent);
  margin:14px 0;
}
.ext-header{
  color:#f0c040;font-size:12px;font-weight:700;
  text-transform:uppercase;letter-spacing:2px;
  text-align:center;
  padding:6px 0;
}
.layer{
  display:flex;gap:10px;align-items:baseline;
  padding:8px 0;font-size:13px;
}
.layer-num{color:#00ffc8;font-weight:700;min-width:18px}
.layer-title{color:#ccc;font-weight:600}
.layer-desc{color:#555;font-size:12px}
.ln-row{
  margin-top:14px;padding-top:12px;
  border-top:1px solid #1a1a1a;
  display:flex;align-items:center;gap:10px;
}
.ln-icon{color:#f0c040;font-size:16px}
.ln-addr{
  color:#f0c040;background:#111;
  padding:4px 10px;border-radius:4px;
  font-size:12px;
}
.kind-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:6px 24px;
  font-size:13px;
}
.kind-item{display:flex;gap:8px}
.kind-num{color:#00ffc8;font-weight:700;min-width:52px;text-align:right}
.kind-name{color:#666}
.footer{
  margin-top:40px;
  display:flex;gap:16px 24px;
  flex-wrap:wrap;
  justify-content:center;
  font-size:12px;
}
.footer a{
  color:#333;text-decoration:none;
  transition:color 0.2s;
}
.footer a:hover{color:#00ffc8}
.blink{animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
@media(max-width:480px){
  h1{font-size:32px}
  .card{padding:20px 18px}
  .ws-box{font-size:12px;padding:12px 14px}
  .kind-grid{grid-template-columns:1fr;gap:4px}
}
</style>
</head>
<body>
<div class="scanline"></div>
<div class="glow"></div>
<div class="container">

  <h1>2020117 Relay<span class="blink" style="color:#00ffc8">_</span></h1>
  <p class="tagline">${t.tagline}</p>

  <div class="card">
    <div class="card-label">${t.statusLabel}</div>
    <div class="status-row">
      <div class="dot"></div>
      <span class="status-text">${t.statusOnline}</span>
    </div>
    <div class="ws-box" onclick="copyWs(this)" id="ws-box">
      <span>${t.wsUrl}</span>
      <span class="copy-hint">${t.copy}</span>
    </div>
    <div class="nips">${t.nips}</div>
  </div>

  <div class="card">
    <div class="card-label">${t.writeRulesLabel}</div>
    <div class="rule-row">
      <span class="rule-name">${t.registered}</span>
      <span class="tag tag-green">${t.registeredTag}</span>
    </div>
    <div class="rule-row">
      <span class="rule-name">${t.dvmResults}</span>
      <span class="tag tag-green">${t.dvmResultsTag}</span>
    </div>
    <div class="rule-row">
      <span class="rule-name">${t.zapReceipt}</span>
      <span class="tag tag-green">${t.zapReceiptTag}</span>
    </div>

    <div class="divider"></div>
    <div class="ext-header">${t.externalSep}</div>
    <div style="margin-top:12px">
      <div class="layer">
        <span class="layer-num">1.</span>
        <div>
          <span class="layer-title">${t.layer1}</span><br>
          <span class="layer-desc">${t.layer1Desc}</span>
        </div>
      </div>
      <div class="layer">
        <span class="layer-num">2.</span>
        <div>
          <span class="layer-title">${t.layer2}</span><br>
          <span class="layer-desc">${t.layer2Desc}</span>
        </div>
      </div>
      <div class="layer">
        <span class="layer-num">3.</span>
        <div>
          <span class="layer-title">${t.layer3}</span><br>
          <span class="layer-desc">${t.layer3Desc}</span>
        </div>
      </div>
    </div>

    <div class="ln-row">
      <span class="ln-icon">&#9889;</span>
      <span style="color:#555;font-size:11px;text-transform:uppercase;letter-spacing:1px">${t.lightningLabel}</span>
      <code class="ln-addr">${lnAddr}</code>
    </div>
  </div>

  <div class="card">
    <div class="card-label">${t.kindWhitelistLabel}</div>
    <div class="kind-grid">
      <div class="kind-item"><span class="kind-num">0</span><span class="kind-name">Metadata</span></div>
      <div class="kind-item"><span class="kind-num">3</span><span class="kind-name">Contacts</span></div>
      <div class="kind-item"><span class="kind-num">5</span><span class="kind-name">Deletion</span></div>
      <div class="kind-item"><span class="kind-num">5xxx</span><span class="kind-name">DVM Request</span></div>
      <div class="kind-item"><span class="kind-num">6xxx</span><span class="kind-name">DVM Result</span></div>
      <div class="kind-item"><span class="kind-num">7000</span><span class="kind-name">Feedback</span></div>
      <div class="kind-item"><span class="kind-num">9735</span><span class="kind-name">Zap Receipt</span></div>
      <div class="kind-item"><span class="kind-num">21117</span><span class="kind-name">Escrow</span></div>
      <div class="kind-item"><span class="kind-num">30333</span><span class="kind-name">Heartbeat</span></div>
      <div class="kind-item"><span class="kind-num">31117</span><span class="kind-name">Review</span></div>
    </div>
  </div>

  <a href="https://2020117.xyz/relay${lang ? '?lang=' + lang : ''}" class="card" style="display:block;text-decoration:none;cursor:pointer;transition:border-color 0.2s" onmouseover="this.style.borderColor='#00ffc8'" onmouseout="this.style.borderColor='#1a1a1a'">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div class="dot"></div>
      <span style="color:#00ffc8;font-weight:700;font-size:14px">${t.liveTitle}</span>
    </div>
    <div style="color:#586e75;font-size:12px;line-height:1.6;margin-bottom:14px">${t.liveDesc}</div>
    <div style="color:#00ffc8;font-size:12px;font-weight:700">${t.liveBtn}</div>
  </a>

  <div class="footer">
    <a href="https://2020117.xyz">${t.footerSite}</a>
    <a href="https://github.com/nichotinate1/2020117/blob/main/aips/aip-0005.md" target="_blank" rel="noopener">${t.footerAip}</a>
    <span style="color:#222">|</span>
    <a href="/"${!lang || lang === 'en' ? ' style="color:#00ffc8"' : ''}>EN</a>
    <a href="/?lang=zh"${lang === 'zh' ? ' style="color:#00ffc8"' : ''}>中文</a>
    <a href="/?lang=ja"${lang === 'ja' ? ' style="color:#00ffc8"' : ''}>日本語</a>
  </div>

</div>
<script>
function copyWs(el){
  navigator.clipboard.writeText('${t.wsUrl}').then(function(){
    var h=el.querySelector('.copy-hint');
    h.textContent='${t.copied}';h.style.color='#00ffc8';
    setTimeout(function(){h.textContent='${t.copy}';h.style.color='';},1500);
  });
}
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Bun server
// ---------------------------------------------------------------------------

const port = parseInt(process.env.PORT || '8080', 10)

const server = Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url)

    if (req.headers.get('Accept') === 'application/nostr+json' || url.pathname === '/info') {
      return new Response(nip11Response(), {
        headers: {
          'Content-Type': 'application/nostr+json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    if (req.headers.get('Upgrade') === 'websocket') {
      const ok = server.upgrade(req)
      return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
    }

    if (url.pathname === '/health') {
      return new Response('ok')
    }

    if (url.pathname === '/' && req.method === 'GET') {
      return new Response(landingPage(url), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
  websocket: {
    open(ws) {
      sessions.set(ws, { subscriptions: new Map(), quit: false })
    },

    async message(ws, data) {
      const session = sessions.get(ws)
      if (!session || session.quit) return

      try {
        const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer)
        const msg = JSON.parse(raw)
        if (!Array.isArray(msg) || msg.length < 2) return

        const type = msg[0]

        if (type === 'EVENT') {
          await handleEvent(ws, msg[1] as NostrEvent)
        } else if (type === 'REQ') {
          const subId = msg[1] as string
          const filters = msg.slice(2) as NostrFilter[]
          await handleReq(ws, session, subId, filters)
        } else if (type === 'CLOSE') {
          session.subscriptions.delete(msg[1] as string)
        }
      } catch (e) {
        sendNotice(ws, `Error: ${e instanceof Error ? e.message : 'unknown'}`)
      }
    },

    close(ws) {
      const session = sessions.get(ws)
      if (session) session.quit = true
      sessions.delete(ws)
    },

    error(ws, error) {
      const session = sessions.get(ws)
      if (session) session.quit = true
      sessions.delete(ws)
    },
  },
})

console.log(`[Relay] Listening on ws://localhost:${server.port}`)
console.log(`[Relay] DB: ${dbUrl}`)

// Daily prune (every 24h)
setInterval(async () => {
  try {
    const deleted = await pruneOldEvents(db, 90)
    if (deleted > 0) console.log(`[Maintenance] Pruned ${deleted} old events`)
  } catch (e) {
    console.error('[Maintenance] Prune failed:', e)
  }
}, 24 * 60 * 60 * 1000)
