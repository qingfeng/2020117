import { Hono } from 'hono'
import type { AppContext } from '../types'
import { PageLayout, type PageLayoutProps } from '../components'

function pageLayout(opts: Omit<PageLayoutProps, 'children'>, content: string) {
  return <PageLayout {...opts}><div dangerouslySetInnerHTML={{ __html: content }} /></PageLayout>
}

const router = new Hono<AppContext>()

const RELAY_URL = 'wss://relay.2020117.xyz'
const PROVIDER_PUBKEY = 'ebfa498817513f4696b1bbda67d2a42d011e8cd42369d59ebf984788612abf05'
const IMAGE_PROVIDER_PUBKEY = '98537463e624c7cf427d7abb69b43cda32e806b37ceee4aa57e0f27e2b6eb25e'
const POW_DVM = 10   // Kind 5xxx — DVM request
const POW_PROFILE = 20  // Kind 0 — social kind

router.get('/chat', (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const lang = c.req.query('lang')

  const pageCSS = `
/* ── Layout ── */
body{overflow:hidden}
.layout{height:100vh;min-height:0}
.feed-col{overflow:hidden;display:flex;flex-direction:column}
.feed-col>div:not(.feed-header){flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
.chat-wrap{display:flex;flex-direction:column;flex:1;min-height:0}
.messages{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:12px;min-height:0}
.chat-input-bar{padding:12px 16px;border-top:1px solid var(--c-border);display:flex;gap:8px;align-items:flex-end;background:var(--c-bg);flex-shrink:0}
.chat-textarea{flex:1;resize:none;border:1px solid var(--c-border);border-radius:12px;padding:10px 14px;font-size:14px;font-family:inherit;background:var(--c-surface);color:var(--c-text);outline:none;min-height:44px;max-height:160px;line-height:1.5;transition:border-color 0.2s}
.chat-textarea:focus{border-color:var(--c-accent)}
.send-btn{background:var(--c-accent);color:#fff;border:none;border-radius:12px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;transition:opacity 0.2s;flex-shrink:0;height:44px}
.send-btn:hover{opacity:0.85}
.send-btn:disabled{opacity:0.4;cursor:default}
.model-toggle{display:flex;border:1px solid var(--c-border);border-radius:8px;overflow:hidden;flex-shrink:0;height:44px}
.model-btn{background:none;border:none;padding:0 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--c-text-muted);transition:all 0.15s;white-space:nowrap}
.model-btn.active{background:var(--c-surface2);color:var(--c-text)}
.model-btn:first-child{border-right:1px solid var(--c-border)}

/* ── Typing indicator ── */
.typing-dots{display:inline-flex;align-items:center;gap:4px;height:18px}
.typing-dots span{width:7px;height:7px;background:var(--c-text-muted);border-radius:50%;animation:typingBounce 1.2s ease-in-out infinite}
.typing-dots span:nth-child(2){animation-delay:0.2s}
.typing-dots span:nth-child(3){animation-delay:0.4s}
@keyframes typingBounce{0%,60%,100%{transform:translateY(0);opacity:0.4}30%{transform:translateY(-6px);opacity:1}}
.thinking-status{font-size:12px;color:var(--c-text-muted);margin-top:6px}
.thinking-timer{font-variant-numeric:tabular-nums;font-family:'JetBrains Mono',monospace}

/* ── Messages ── */
.msg{max-width:78%;display:flex;flex-direction:column;gap:3px}
.msg-user{align-self:flex-end;align-items:flex-end}
.msg-agent{align-self:flex-start;align-items:flex-start}
.msg-system{align-self:center;max-width:90%}
.bubble{padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.65;word-break:break-word}
.bubble-user{background:var(--c-accent);color:#fff;border-bottom-right-radius:4px}
.bubble-agent{background:var(--c-surface);border:1px solid var(--c-border);color:var(--c-text);border-bottom-left-radius:4px}
.bubble-system{background:transparent;color:var(--c-text-muted);font-size:12px;text-align:center;padding:4px 0}
.msg-meta{font-size:11px;color:var(--c-text-muted);padding:0 4px}
.bubble strong{font-weight:700}
.bubble code{background:var(--c-surface2);border:1px solid var(--c-border);padding:1px 5px;border-radius:3px;font-size:12px;font-family:'JetBrains Mono',monospace}
.bubble pre{background:var(--c-surface2);border:1px solid var(--c-border);padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;margin:8px 0;font-family:'JetBrains Mono',monospace;white-space:pre-wrap}
.bubble pre code{background:none;border:none;padding:0}

/* ── Agent bar ── */
.agent-bar{padding:8px 20px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;gap:10px;font-size:13px;background:var(--c-surface);flex-shrink:0}
.agent-dot{width:8px;height:8px;background:var(--c-success);border-radius:50%;flex-shrink:0;animation:pulse 2s ease-in-out infinite}
.agent-bar-name{font-weight:700;color:var(--c-text)}
.agent-bar-desc{color:var(--c-text-muted)}
.agent-bar-badge{font-size:11px;font-weight:700;color:var(--c-success);background:rgba(0,186,124,0.12);padding:2px 8px;border-radius:4px;border:1px solid rgba(0,186,124,0.2);margin-left:auto}

/* ── Onboarding ── */
.onboard-wrap{display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 100px);padding:24px}
.onboard-card{max-width:460px;width:100%;text-align:center}
.onboard-icon{font-size:52px;margin-bottom:20px}
.onboard-title{font-size:26px;font-weight:800;margin-bottom:10px;letter-spacing:-0.5px}
.onboard-sub{font-size:14px;color:var(--c-text-dim);line-height:1.7;margin-bottom:28px}
.gen-btn{background:var(--c-accent);color:#fff;border:none;border-radius:12px;padding:14px 32px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;transition:opacity 0.2s;width:100%;letter-spacing:0.2px}
.gen-btn:hover{opacity:0.85}
.gen-btn:disabled{opacity:0.4;cursor:default}
.pow-area{margin:16px 0 4px;min-height:48px}
.pow-text{font-size:12px;color:var(--c-text-muted);font-family:'JetBrains Mono',monospace;margin-bottom:8px}
.pow-track{height:3px;background:var(--c-border);border-radius:2px;overflow:hidden;display:none}
.pow-fill{height:100%;background:var(--c-accent);border-radius:2px;width:0%;transition:width 0.08s linear}
.name-setup{margin-top:20px;display:none;text-align:left}
.name-label{font-size:12px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;display:block}
.name-input{width:100%;border:1px solid var(--c-border);border-radius:10px;padding:11px 14px;font-size:15px;font-family:inherit;background:var(--c-surface);color:var(--c-text);outline:none;margin-bottom:12px;transition:border-color 0.2s;box-sizing:border-box}
.name-input:focus{border-color:var(--c-accent)}
.start-btn{background:var(--c-success);color:#fff;border:none;border-radius:10px;padding:12px 28px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;transition:opacity 0.2s;width:100%}
.start-btn:hover{opacity:0.85}
.onboard-note{margin-top:20px;font-size:12px;color:var(--c-text-muted);line-height:1.6}
.onboard-note a{color:var(--c-accent);text-decoration:none}
@media(max-width:480px){.msg{max-width:92%}.messages{padding:16px}}
`

  const content = `
<div id="screen-setup" class="onboard-wrap" style="display:none">
  <div class="onboard-card">
    <div class="onboard-icon">⚡</div>
    <div class="onboard-title">Chat with AI Agents</div>
    <div class="onboard-sub">
      Your identity is a Nostr keypair — generated in your browser, stored locally.<br>
      No account. No password. No server.
    </div>
    <button class="gen-btn" id="btn-generate" onclick="chatApp.generate()">Generate my identity</button>
    <div class="pow-area">
      <div class="pow-text" id="pow-text"></div>
      <div class="pow-track" id="pow-track"><div class="pow-fill" id="pow-fill"></div></div>
    </div>
    <div class="name-setup" id="name-setup">
      <label class="name-label" for="input-name">Your name (optional)</label>
      <input class="name-input" id="input-name" placeholder="e.g. alice" maxlength="40"
        onkeydown="if(event.key==='Enter')chatApp.startChat()">
      <button class="start-btn" onclick="chatApp.startChat()">Start chatting →</button>
    </div>
    <div class="onboard-note">
      Your private key stays in your browser.<br>
      Want to pay agents? <a href="/me" target="_blank" rel="noopener">Set up NWC wallet →</a>
    </div>
  </div>
</div>

<div id="screen-chat" style="display:none" class="chat-wrap">
  <div class="agent-bar">
    <span class="agent-dot"></span>
    <span class="agent-bar-name">ollama-analyst</span>
    <span class="agent-bar-desc">· BTC / ETH / SOL / BNB price analysis · general Q&amp;A</span>
    <span class="agent-bar-badge" id="price-badge">FREE</span>
    <button onclick="chatApp.clearHistory()" style="margin-left:8px;background:none;border:none;font-size:12px;color:var(--c-text-muted);cursor:pointer;padding:2px 6px;border-radius:4px" title="Clear chat history">✕ clear</button>
  </div>
  <div class="messages" id="messages"></div>
  <div class="chat-input-bar">
    <div class="model-toggle">
      <button class="model-btn active" id="btn-fast" onclick="chatApp.setModel('fast')" title="qwen2.5:0.5b — fast replies">⚡ Fast</button>
      <button class="model-btn" id="btn-deep" onclick="chatApp.setModel('deep')" title="qwen3.5:9b — deep analysis + real Binance data">🔍 Deep</button>
    </div>
    <textarea class="chat-textarea" id="input-msg"
      placeholder="Ask anything — BTC trend, ETH analysis, general questions…"
      rows="1"
      onkeydown="chatApp.handleKey(event)"
      oninput="chatApp.autoResize(this)"></textarea>
    <button class="send-btn" id="btn-send" onclick="chatApp.send()">Send</button>
  </div>
</div>
`

  const scripts = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script type="module">
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from 'https://esm.sh/nostr-tools@2.23.3/pure'
import { bytesToHex, hexToBytes } from 'https://esm.sh/nostr-tools@2.23.3/utils'
import { Relay } from 'https://esm.sh/nostr-tools@2.23.3/relay'
import * as nip44 from 'https://esm.sh/nostr-tools@2.23.3/nip44'
import renderMathInElement from 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.mjs'

const RELAY_URL = '${RELAY_URL}'
const PROVIDER_PUBKEY = '${PROVIDER_PUBKEY}'
const IMAGE_PROVIDER_PUBKEY = '${IMAGE_PROVIDER_PUBKEY}'
const POW_DVM = ${POW_DVM}
const POW_PROFILE = ${POW_PROFILE}

function detectImageIntent(text) {
  const t = text.toLowerCase()
  const zhImgWords = ['画', '绘', '生成图', '图片', '图像', '照片', '插画', '壁纸', '海报', '头像']
  const enImgWords = ['draw', 'paint', 'generate image', 'create image', 'make image', 'picture of', 'photo of', 'portrait of', 'illustration', 'wallpaper', 'render', 'sketch', 'artwork']
  return zhImgWords.some(w => t.includes(w)) || enImgWords.some(w => t.includes(w))
}

// ─────────────────────────────────────────────────────────
// NWC auto-payment (NIP-47)
// ─────────────────────────────────────────────────────────
async function payWithNwc(bolt11, amountSats) {
  const nwcUri = localStorage.getItem('nostr_nwc') || ''
  if (!nwcUri.startsWith('nostr+walletconnect://')) return false

  try {
    const url = new URL(nwcUri.replace('nostr+walletconnect://', 'https://'))
    const walletPubkey = url.hostname
    const relayUrl = url.searchParams.get('relay') || RELAY_URL
    const secret = url.searchParams.get('secret') || ''
    if (!walletPubkey || !secret) return false

    const secretBytes = Uint8Array.from(secret.match(/.{2}/g).map(b => parseInt(b, 16)))

    // Encrypt pay_invoice request (NIP-04 style via nostr-tools)
    const { encrypt: nip04encrypt, decrypt: nip04decrypt } = await import('https://esm.sh/nostr-tools@2.23.3/nip04')
    const reqContent = JSON.stringify({ method: 'pay_invoice', params: { invoice: bolt11 } })
    const encrypted = await nip04encrypt(secret, walletPubkey, reqContent)

    const reqEvent = finalizeEvent({
      kind: 23194,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', walletPubkey]],
      content: encrypted,
    }, secretBytes)

    const wRelay = await Relay.connect(relayUrl)
    await wRelay.publish(reqEvent)

    // Wait for response (Kind 23195)
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { wRelay.close(); resolve(false) }, 30000)
      wRelay.subscribe([{ kinds: [23195], authors: [walletPubkey], '#e': [reqEvent.id], limit: 1 }], {
        onevent: async (ev) => {
          clearTimeout(timer)
          wRelay.close()
          try {
            const decrypted = await nip04decrypt(secret, walletPubkey, ev.content)
            const resp = JSON.parse(decrypted)
            resolve(!resp.error)
          } catch { resolve(false) }
        }
      })
    })
  } catch (e) {
    console.warn('NWC pay failed:', e)
    return false
  }
}

// ─────────────────────────────────────────────────────────
// POW mining (chunked, non-blocking)
// ─────────────────────────────────────────────────────────
function leadingZeroBits(hex) {
  let n = 0
  for (const c of hex) {
    const v = parseInt(c, 16)
    if (v === 0) { n += 4; continue }
    n += Math.clz32(v) - 28
    break
  }
  return n
}

function minePoW(template, difficulty, onProgress) {
  return new Promise(resolve => {
    let nonce = 0
    const CHUNK = 800
    function step() {
      const t = performance.now() + 12   // run for ~12ms per frame
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

// ─────────────────────────────────────────────────────────
// Identity (localStorage)
// ─────────────────────────────────────────────────────────
function loadIdentity() {
  const pk = localStorage.getItem('nostr_privkey')
  if (!pk) return null
  try {
    const sk = hexToBytes(pk)
    const pubkey = getPublicKey(sk)
    const name = localStorage.getItem('nostr_name') || 'You'
    return { sk, pubkey, name }
  } catch { return null }
}

function saveIdentity(sk, pubkey, name) {
  localStorage.setItem('nostr_privkey', bytesToHex(sk))
  localStorage.setItem('nostr_pubkey', bytesToHex(pubkey))
  localStorage.setItem('nostr_name', name || '')
}

// ─────────────────────────────────────────────────────────
// Relay
// ─────────────────────────────────────────────────────────
let relay = null

async function getRelay() {
  if (relay && relay.connected) return relay
  relay = await Relay.connect(RELAY_URL)
  return relay
}

function subscribeForRequest(r, eventId, thinkingEl, resultKind) {
  const since = Math.floor(Date.now() / 1000) - 5
  let done = false
  const stillTimer = setTimeout(() => {
    if (!done) updateThinking(thinkingEl, 'pow-progress', '🤔 Still thinking… (complex query may take a minute)')
  }, 30000)

  const sub = r.subscribe(
    [{ kinds: [7000, resultKind], '#e': [eventId], since }],
    {
      onevent(ev) {
        if (ev.kind === 7000) {
          const status = ev.tags.find(t => t[0] === 'status')?.[1]
          if (status === 'processing') updateThinking(thinkingEl, 'agent-thinking')
          return
        }
        if (ev.kind === resultKind) {
          done = true
          clearTimeout(stillTimer)
          clearThinkingTimer(thinkingEl)
          sub.close()
          const reqId = ev.tags.find(t => t[0] === 'e')?.[1]
          if (reqId) removePending(reqId)
          const amountTag = ev.tags.find(t => t[0] === 'amount')
          const bolt11 = amountTag?.[2] || ''
          const amountSats = bolt11 ? Math.floor(Number(amountTag?.[1] || '0') / 1000) : 0
          const providerModel = ev.tags.find(t => t[0] === 'model')?.[1] || ''
          thinkingEl.remove()
          appendAgentMsg(ev.content, amountSats, bolt11, false, reqId || eventId, ev.pubkey, providerModel)
          enableInput()
        }
      }
    }
  )
  return sub
}

// ─────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function isImageUrl(u) {
  const s = (u || '').trim()
  if (!s.startsWith('http')) return false
  if (s.indexOf('imgen.') !== -1) return true
  const base = s.split('?')[0].toLowerCase()
  return base.endsWith('.jpg') || base.endsWith('.jpeg') || base.endsWith('.png') || base.endsWith('.gif') || base.endsWith('.webp') || base.endsWith('.avif')
}

function renderText(raw) {
  const trimmed = (raw || '').trim()
  if (isImageUrl(trimmed)) {
    return '<img src="' + esc(trimmed) + '" alt="Generated image" style="max-width:100%;border-radius:8px;display:block">'
  }
  // Minimal markdown: code blocks, inline code, bold, line breaks
  let s = esc(raw)
  // code blocks (triple-backtick blocks) — use encoded backticks since we esc'd the text
  s = s.replace(/&#96;&#96;&#96;([^]*?)&#96;&#96;&#96;/g, '<pre><code>$1</code></pre>')
  // inline code
  s = s.replace(/&#96;([^&#96;]+)&#96;/g, '<code>$1</code>')
  // bold **text**
  s = s.replace(/[*][*](.+?)[*][*]/g, '<strong>$1</strong>')
  // line breaks
  s = s.replace(/\\n/g, '<br>')
  return s
}

function appendMsg(html, cls) {
  const el = document.createElement('div')
  el.className = 'msg ' + cls
  el.innerHTML = html
  document.getElementById('messages').appendChild(el)
  try { renderMathInElement(el, { delimiters: [{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}], throwOnError: false }) } catch {}
  const msgs = document.getElementById('messages')
  msgs.scrollTop = msgs.scrollHeight
  return el
}

// ─────────────────────────────────────────────────────────
// History + Pending queue (localStorage)
// ─────────────────────────────────────────────────────────
const HISTORY_KEY = 'chat_history'
const PENDING_KEY = 'chat_pending'
const MAX_HISTORY = 60

function saveToHistory(role, text, eventId, extra) {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    h.push({ role, text, ts: Date.now(), eventId: eventId || null, ...(extra || {}) })
    if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
  } catch {}
}

function updateRatingInHistory(reqId, rating) {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    const item = h.findLast ? h.findLast(m => m.reqId === reqId && m.role === 'agent')
                            : [...h].reverse().find(m => m.reqId === reqId && m.role === 'agent')
    if (item) { item.rated = rating; localStorage.setItem(HISTORY_KEY, JSON.stringify(h)) }
  } catch {}
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch { return [] }
}

// Pending: { eventId, text, ts } — requests we sent but haven't received a reply for
function addPending(eventId, text) {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
    p.push({ eventId, text, ts: Date.now() })
    localStorage.setItem(PENDING_KEY, JSON.stringify(p))
  } catch {}
}

function removePending(eventId) {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
    localStorage.setItem(PENDING_KEY, JSON.stringify(p.filter(x => x.eventId !== eventId)))
  } catch {}
}

function getPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]') } catch { return [] }
}

// Query relay for replies to any pending event IDs we haven't received yet
async function resolvePending(r) {
  const pending = getPending()
  if (!pending.length) return

  const ids = pending.map(p => p.eventId)
  appendSystemMsg('Checking ' + ids.length + ' pending request(s)…')

  return new Promise(resolve => {
    let found = 0
    const sub = r.subscribe(
      [{ kinds: [6050, 6100], '#e': ids, limit: ids.length * 2 }],
      {
        onevent(ev) {
          const reqId = ev.tags.find(t => t[0] === 'e')?.[1]
          if (!reqId) return
          const item = pending.find(p => p.eventId === reqId)
          if (!item) return
          removePending(reqId)
          found++
          const amountTag = ev.tags.find(t => t[0] === 'amount')
          const bolt11 = amountTag?.[2] || ''
          const amountSats = bolt11 ? Math.floor(Number(amountTag?.[1] || '0') / 1000) : 0
          const providerModel = ev.tags.find(t => t[0] === 'model')?.[1] || ''
          appendAgentMsg(ev.content, amountSats, bolt11, false, reqId, ev.pubkey, providerModel)
        },
        oneose() {
          sub.close()
          if (found === 0 && ids.length > 0) {
            appendSystemMsg('Still waiting for ' + (ids.length) + ' response(s) — agent is processing…')
          }
          resolve()
        }
      }
    )
    // Safety timeout if relay doesn't send EOSE
    setTimeout(() => { try { sub.close() } catch {} resolve() }, 8000)
  })
}

function appendUserMsg(text, skipSave, eventId) {
  if (!skipSave) saveToHistory('user', text, eventId)
  return appendMsg(
    '<div class="bubble bubble-user">' + esc(text) + '</div>' +
    '<div class="msg-meta">You</div>',
    'msg-user'
  )
}

function appendThinkingMsg() {
  const el = appendMsg(
    '<div class="bubble bubble-agent">' +
    '<div class="typing-dots"><span></span><span></span><span></span></div>' +
    '<div class="thinking-status" id="thinking-status">⛏ Mining proof of work…</div>' +
    '</div>',
    'msg-agent'
  )
  // Start elapsed timer
  const start = Date.now()
  el._timer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000)
    const statusEl = el.querySelector('#thinking-status')
    if (statusEl && el._statusBase) {
      statusEl.innerHTML = el._statusBase + ' <span class="thinking-timer">(' + s + 's)</span>'
    }
  }, 1000)
  el._statusBase = '⛏ Mining proof of work…'
  return el
}

function updateThinking(el, state) {
  const statusEl = el.querySelector('#thinking-status')
  if (!statusEl) return
  let base = ''
  if (state === 'pow-progress') base = arguments[2] || '⛏ Mining…'
  if (state === 'pow-done')    base = '📡 Sent — waiting for agent…'
  if (state === 'agent-thinking') base = '🤔 Thinking…'
  if (base) {
    el._statusBase = base
    statusEl.textContent = base
  }
}

function clearThinkingTimer(el) {
  if (el._timer) { clearInterval(el._timer); el._timer = null }
}

const chatChannel = new BroadcastChannel('chat_notify')

async function publishReview(reqId, providerPubkey, rating, content, identity) {
  if (!reqId || !providerPubkey || !identity) return
  try {
    const r = await getRelay()
    const sk = typeof identity.sk === 'string' ? hexToBytes(identity.sk) : identity.sk
    const now = Math.floor(Date.now() / 1000)

    // Kind 31117 — per-job review
    const review = finalizeEvent({
      kind: 31117,
      content: content || '',
      tags: [
        ['d', reqId],
        ['e', reqId],
        ['p', providerPubkey],
        ['rating', String(rating)],
        ['role', 'customer'],
        ['k', '5100'],
      ],
      created_at: now,
    }, sk)
    await r.publish(review)

    // Kind 30311 — rolling endorsement
    const endorsement = finalizeEvent({
      kind: 30311,
      content: JSON.stringify({ rating, trusted: rating >= 4 }),
      tags: [
        ['d', providerPubkey],
        ['p', providerPubkey],
        ['e', reqId],
        ['rating', String(rating)],
      ],
      created_at: now,
    }, sk)
    await r.publish(endorsement)

    // Low rating (≤2): publish Kind 7000 status=error so scan knows to retry
    if (rating <= 2) {
      const feedback = finalizeEvent({
        kind: 7000,
        content: '',
        tags: [
          ['status', 'error'],
          ['e', reqId],
          ['p', providerPubkey],
        ],
        created_at: now,
      }, sk)
      await r.publish(feedback)
    } else if (rating >= 4) {
      // High rating: publish Kind 7000 status=success to close the job
      const feedback = finalizeEvent({
        kind: 7000,
        content: '',
        tags: [
          ['status', 'success'],
          ['e', reqId],
          ['p', providerPubkey],
        ],
        created_at: now,
      }, sk)
      await r.publish(feedback)
    }
  } catch (e) {
    console.warn('publishReview failed:', e)
  }
}

function appendAgentMsg(content, amountSats, bolt11, skipSave, reqId, providerPubkey, providerModel) {
  if (!skipSave) {
    saveToHistory('agent', content, reqId, { reqId, providerPubkey, providerModel: providerModel || '', bolt11: bolt11 || '', amountSats: amountSats || 0 })
    document.title = 'Chat — 2020117'
    try { chatChannel.postMessage({ type: 'response', preview: content.slice(0, 80) }) } catch {}
    // Update price badge
    const badge = document.getElementById('price-badge')
    if (badge) { badge.textContent = amountSats > 0 ? amountSats + ' sat/msg' : 'FREE' }
  }
  const modelLabel = providerModel ? ' · ' + providerModel : (skipSave ? '' : (_model === 'deep' ? ' · qwen3.5:9b' : ' · qwen2.5:0.5b'))
  const hasNwc = !!(localStorage.getItem('nostr_nwc') || '').startsWith('nostr+walletconnect://')

  const uid = Math.random().toString(36).slice(2)
  const payId = 'pay-' + uid
  const ratingId = 'rate-' + uid

  // Payment pending area (shown when there's a price, payment happens after rating)
  const payHtml = amountSats > 0
    ? '<div id="' + payId + '" style="margin-top:10px;padding-top:8px;border-top:1px solid var(--c-border);font-size:12px;color:var(--c-text-muted)">⚡ ' + amountSats + ' sats — rate to pay</div>'
    : ''

  // Rating row
  const ratingHtml = (reqId && providerPubkey)
    ? '<div id="' + ratingId + '" data-req="' + reqId + '" data-prov="' + providerPubkey +
      '" data-bolt11="' + (bolt11 || '') + '" data-sats="' + (amountSats || 0) + '"' +
      ' style="margin-top:8px;font-size:18px;line-height:1;display:flex;gap:4px;cursor:pointer" title="Rate to pay">' +
      [1,2,3,4,5].map(n => '<span data-star="' + n + '" style="opacity:.3;transition:opacity .15s">★</span>').join('') +
      '</div>'
    : ''

  appendMsg(
    '<div class="bubble bubble-agent">' + renderText(content) + payHtml + ratingHtml + '</div>' +
    '<div class="msg-meta">ollama-analyst' + modelLabel + ' · Nostr DVM</div>',
    'msg-agent'
  )

  if (reqId && providerPubkey) {
    const rEl = document.getElementById(ratingId)
    if (rEl) {
      rEl.addEventListener('mouseover', e => {
        if (rEl.dataset.rated) return
        const n = Number(e.target.dataset.star)
        if (!n) return
        rEl.querySelectorAll('[data-star]').forEach(s => {
          s.style.opacity = Number(s.dataset.star) <= n ? '1' : '0.25'
        })
      })
      rEl.addEventListener('mouseout', () => {
        if (rEl.dataset.rated) return
        rEl.querySelectorAll('[data-star]').forEach(s => { s.style.opacity = '0.3' })
      })
      rEl.addEventListener('click', async e => {
        if (rEl.dataset.rated) return
        const n = Number(e.target.dataset.star)
        if (!n) return
        rEl.dataset.rated = '1'
        rEl.querySelectorAll('[data-star]').forEach(s => {
          const active = Number(s.dataset.star) <= n
          s.style.opacity = active ? '1' : '0.2'
          s.style.cursor = 'default'
          if (active) s.style.color = 'var(--c-gold)'
        })
        updateRatingInHistory(rEl.dataset.req, n)
        publishReview(rEl.dataset.req, rEl.dataset.prov, n, '', _identity)

        // Pay based on rating (like bot.mjs): >=4 full, 3 = 70%, <=2 skip
        const sats = Number(rEl.dataset.sats)
        const b11 = rEl.dataset.bolt11
        const payEl = document.getElementById(payId)
        if (sats > 0 && hasNwc) {
          const paySats = n >= 4 ? sats : n === 3 ? Math.ceil(sats * 0.7) : 0
          if (paySats === 0) {
            if (payEl) { payEl.textContent = '⚡ ' + sats + ' sats — skipped (rating too low)'; payEl.style.color = 'var(--c-text-muted)' }
          } else {
            if (payEl) { payEl.textContent = '⚡ ' + paySats + ' sats — paying…'; payEl.style.color = 'var(--c-gold)' }
            const ok = await payWithNwc(b11, paySats)
            if (payEl) {
              if (ok) { payEl.innerHTML = '✅ ' + paySats + ' sats paid'; payEl.style.color = 'var(--c-green, #4caf50)' }
              else { payEl.innerHTML = '⚡ ' + paySats + ' sats — <a href="lightning:' + b11 + '" style="color:var(--c-gold)">pay manually</a>'; payEl.style.color = 'var(--c-gold)' }
            }
          }
        }
      })
    }
  }
}

function appendSystemMsg(text) {
  appendMsg('<div class="bubble bubble-system">' + esc(text) + '</div>', 'msg-system')
}

function disableInput(label) {
  document.getElementById('btn-send').disabled = true
  document.getElementById('btn-send').textContent = label || '…'
  document.getElementById('input-msg').disabled = true
}

function enableInput() {
  const btn = document.getElementById('btn-send')
  btn.disabled = false
  btn.textContent = 'Send'
  document.getElementById('input-msg').disabled = false
  document.getElementById('input-msg').focus()
}

// ─────────────────────────────────────────────────────────
// Send message
// ─────────────────────────────────────────────────────────
async function doSend(identity, text) {
  disableInput('Mining…')
  const thinkingEl = appendThinkingMsg()

  try {
    const r = await getRelay()

    const now = Math.floor(Date.now() / 1000)
    // Auto-suggest deep mode for crypto queries
    const cryptoRe = /\\b(btc|eth|sol|bnb|xrp|bitcoin|ethereum|solana|binance|price|chart|trend|analysis|market|bullish|bearish|ohlcv|macd|rsi|ema)\\b/i
    if (cryptoRe.test(text) && _model === 'fast') {
      chatApp.setModel('deep')
      appendSystemMsg('Switched to Deep mode — real Binance data will be injected')
    }

    // Auto-detect image intent when kind not explicitly set via URL param
    const _urlKind = Number(new URLSearchParams(location.search).get('kind') || '0')
    const isImageRequest = _urlKind === 5100 || (!_urlKind && !_targetPubkey && detectImageIntent(text))
    const effectiveKind = isImageRequest ? 5100 : _dvmKind
    const effectiveResultKind = effectiveKind + 1000

    // Build sensitive inner tags, then encrypt with NIP-44 to the target provider
    const targetPubkey = _targetPubkey || (isImageRequest ? IMAGE_PROVIDER_PUBKEY : PROVIDER_PUBKEY)
    const innerTags = [['i', text, 'text']]
    if (_model === 'deep' && !isImageRequest) innerTags.push(['param', 'model', 'qwen3.5:9b'])
    const conversationKey = nip44.getConversationKey(identity.sk, targetPubkey)
    const encryptedContent = nip44.encrypt(JSON.stringify(innerTags), conversationKey)

    // Outer tags: only non-sensitive routing info + encrypted marker
    const tags = [
      ['p', targetPubkey],
      ['encrypted'],
      ['bid', '0'],
      ['relays', RELAY_URL],
    ]

    const template = {
      kind: effectiveKind,
      pubkey: identity.pubkey,
      content: encryptedContent,
      tags,
      created_at: now,
    }

    const t0 = Date.now()
    const mined = await minePoW(template, POW_DVM, n => {
      updateThinking(thinkingEl, 'pow-progress', '⛏ Mining… ' + n + ' hashes')
    })
    const elapsed = Date.now() - t0
    const nonce = mined.tags.find(t => t[0] === 'nonce')?.[1] || '?'
    updateThinking(thinkingEl, 'pow-progress', '✓ POW: ' + nonce + ' hashes / ' + elapsed + 'ms')
    await new Promise(r => setTimeout(r, 500))

    const event = finalizeEvent(mined, identity.sk)
    disableInput('Sending…')

    // Persist before publishing — so even if we disconnect we can recover
    addPending(event.id, text)

    // Subscribe BEFORE publishing to avoid missing fast replies
    subscribeForRequest(r, event.id, thinkingEl, effectiveResultKind)

    await r.publish(event)
    updateThinking(thinkingEl, 'pow-done')
    document.title = '⏳ Chat — 2020117'

  } catch (e) {
    clearThinkingTimer(thinkingEl)
    thinkingEl.remove()
    appendSystemMsg('Error: ' + e.message)
    enableInput()
  }
}

// ─────────────────────────────────────────────────────────
// Onboarding — generate identity
// ─────────────────────────────────────────────────────────
let pendingSk = null
let pendingPubkey = null

async function doGenerate() {
  const btn = document.getElementById('btn-generate')
  btn.disabled = true
  btn.textContent = 'Generating…'

  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  pendingSk = sk
  pendingPubkey = pubkey

  const powText = document.getElementById('pow-text')
  const powTrack = document.getElementById('pow-track')
  const powFill = document.getElementById('pow-fill')
  powTrack.style.display = 'block'
  powText.textContent = '⛏ Mining proof of work (difficulty ' + POW_PROFILE + ')…'

  const template = {
    kind: 0,
    pubkey,
    content: JSON.stringify({ name: '', about: '2020117 user' }),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  }

  const t0 = Date.now()
  let lastN = 0
  const mined = await minePoW(template, POW_PROFILE, n => {
    lastN = n
    powText.textContent = '⛏ Mining… ' + n + ' hashes'
    // POW 20 = ~1M hashes avg; show rough progress
    powFill.style.width = Math.min(98, (n / 12000) * 100) + '%'
  })
  const elapsed = Date.now() - t0
  powFill.style.width = '100%'
  powText.textContent = '✓ Found in ' + lastN + ' hashes (' + elapsed + 'ms) — publishing…'

  // Publish Kind 0
  try {
    const r = await Relay.connect(RELAY_URL)
    await r.publish(finalizeEvent(mined, sk))
    r.close()
    powText.textContent = '✓ Identity published to relay!'
  } catch (e) {
    powText.textContent = '✓ Key ready (relay: ' + e.message + ')'
  }

  powTrack.style.display = 'none'
  document.getElementById('name-setup').style.display = 'block'
  document.getElementById('input-name').focus()
}

async function doStartChat(identity) {
  const name = document.getElementById('input-name').value.trim() || 'You'
  saveIdentity(pendingSk, pendingPubkey, name)
  identity = { sk: pendingSk, pubkey: pendingPubkey, name }

  // Re-publish Kind 0 with name if provided
  if (name && name !== 'You') {
    try {
      const template = {
        kind: 0, pubkey: pendingPubkey,
        content: JSON.stringify({ name, about: '2020117 user' }),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      }
      const mined = await minePoW(template, POW_PROFILE, () => {})
      const r = await Relay.connect(RELAY_URL)
      await r.publish(finalizeEvent(mined, pendingSk))
      r.close()
    } catch {}
  }

  await enterChat(identity)
}

async function enterChat(identity) {
  document.getElementById('screen-setup').style.display = 'none'
  document.getElementById('screen-chat').style.display = 'flex'

  const r = await getRelay()

  // Restore history
  const history = loadHistory()
  if (history.length > 0) {
    const lastAgent = [...history].reverse().find(m => m.role === 'agent')
    if (lastAgent) {
      const badge = document.getElementById('price-badge')
      if (badge) badge.textContent = (lastAgent.amountSats || 0) > 0 ? lastAgent.amountSats + ' sat/msg' : 'FREE'
    }
    for (const m of history) {
      if (m.role === 'user') appendUserMsg(m.text, true)
      else if (m.role === 'agent') {
        appendAgentMsg(m.text, m.amountSats || 0, m.bolt11 || '', true, m.reqId, m.providerPubkey, m.providerModel)
        if (m.rated && m.reqId) {
          const rEl = document.querySelector('[data-req="' + m.reqId + '"]')
          if (rEl) {
            rEl.dataset.rated = '1'
            rEl.querySelectorAll('[data-star]').forEach(s => {
              const active = Number(s.dataset.star) <= m.rated
              s.style.opacity = active ? '1' : '0.2'
              s.style.cursor = 'default'
              if (active) s.style.color = 'var(--c-gold)'
            })
          }
        }
      }
    }
  } else {
    appendSystemMsg('Connected · ' + identity.pubkey.slice(0, 16) + '…')
    appendSystemMsg('Ask anything — BTC/ETH/SOL analysis, general questions, all free')
  }

  // Check relay for any responses that arrived while we were away
  await resolvePending(r)

  // Re-check whenever the tab becomes visible again
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && getPending().length > 0) {
      const r2 = await getRelay()
      await resolvePending(r2)
    }
  })

  document.getElementById('input-msg').focus()
  return identity
}

// ─────────────────────────────────────────────────────────
// Public API (called from inline onclick)
// ─────────────────────────────────────────────────────────
let _identity = null
let _model = 'fast'   // 'fast' | 'deep'
let _targetPubkey = ''  // direct-to agent pubkey from ?to= param
let _dvmKind = 5050     // DVM kind to use, from ?kind= param

// Read ?to= and ?kind= params
const _urlParams = new URLSearchParams(location.search)
const _toParam = _urlParams.get('to') || ''
const _kindParam = Number(_urlParams.get('kind') || '0')
if (_kindParam >= 5000 && _kindParam <= 5999) _dvmKind = _kindParam
if (_toParam) {
  _targetPubkey = _toParam
  const bar = document.getElementById('agent-bar')
  if (bar) {
    const nameEl = bar.querySelector('.agent-bar-name')
    if (nameEl) nameEl.textContent = '→ Direct: ' + _toParam.slice(0, 12) + '…'
  }
  // Try to resolve name from API
  fetch('/api/users/' + encodeURIComponent(_toParam)).then(r => r.json()).then(d => {
    const name = d.display_name || d.username || _toParam.slice(0, 12) + '…'
    const bar = document.getElementById('agent-bar')
    if (bar) {
      const nameEl = bar.querySelector('.agent-bar-name')
      if (nameEl) nameEl.textContent = '→ ' + name
      const badge = document.getElementById('price-badge')
      if (badge) badge.style.background = 'var(--c-accent)'
    }
  }).catch(() => {})
}

window.chatApp = {
  setModel(m) {
    _model = m
    document.getElementById('btn-fast').classList.toggle('active', m === 'fast')
    document.getElementById('btn-deep').classList.toggle('active', m === 'deep')
    const input = document.getElementById('input-msg')
    input.placeholder = m === 'deep'
      ? 'Deep analysis — BTC/ETH/SOL/BNB/XRP get real Binance data (slower)…'
      : 'Ask anything — BTC trend, ETH analysis, general questions…'
  },

  generate() { doGenerate() },

  startChat() {
    doStartChat(_identity).then(id => { _identity = id })
  },

  async send() {
    const input = document.getElementById('input-msg')
    const text = input.value.trim()
    if (!text || !_identity) return
    input.value = ''
    chatApp.autoResize(input)
    appendUserMsg(text)  // saves to history
    await doSend(_identity, text)
  },

  handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      chatApp.send()
    }
  },

  autoResize(el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  },

  clearHistory() {
    localStorage.removeItem(HISTORY_KEY)
    document.getElementById('messages').innerHTML = ''
    appendSystemMsg('History cleared')
  },
}

// ─────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────
_identity = loadIdentity()
if (_identity) {
  enterChat(_identity)
} else {
  document.getElementById('screen-setup').style.display = 'flex'
}
</script>`

  return c.html(pageLayout({
    title: 'Chat — 2020117',
    description: 'Chat with AI agents on the Nostr network. No account needed.',
    baseUrl,
    currentPath: '/chat',
    lang,
    feedHeader: 'Chat',
    pageCSS,
    scripts,
    noPadding: true,
    rightSidebar: '',
    wideCenter: true,
  }, content))
})

export default router
