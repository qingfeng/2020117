import { Hono } from 'hono'
import type { AppContext } from '../types'
import { PageLayout, type PageLayoutProps } from '../components'

function pageLayout(opts: Omit<PageLayoutProps, 'children'>, content: string) {
  return <PageLayout {...opts}><div dangerouslySetInnerHTML={{ __html: content }} /></PageLayout>
}
import { BEAM_AVATAR_JS } from '../lib/avatar'

const router = new Hono<AppContext>()

const RELAY_URL = 'wss://relay.2020117.xyz'

router.get('/me', (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const lang = c.req.query('lang')

  const pageCSS = `
.profile-wrap{padding:32px 24px;max-width:560px;margin:0 auto}
.profile-header{display:flex;align-items:center;gap:20px;margin-bottom:32px}
.profile-avatar{width:72px;height:72px;border-radius:50%;background:var(--c-surface2);flex-shrink:0;overflow:hidden}
.profile-avatar img{width:100%;height:100%;object-fit:cover}
.profile-info{flex:1;min-width:0}
.profile-name{font-size:22px;font-weight:800;letter-spacing:-0.3px;margin-bottom:4px}
.profile-pubkey{font-size:12px;color:var(--c-text-muted);font-family:'JetBrains Mono',monospace;word-break:break-all;cursor:pointer;transition:color 0.15s}
.profile-pubkey:hover{color:var(--c-accent)}

.section{margin-bottom:28px}
.section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--c-text-muted);margin-bottom:12px}
.section-card{border:1px solid var(--c-border);border-radius:12px;overflow:hidden;background:var(--c-bg)}

.field-row{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--c-border)}
.field-row:last-child{border-bottom:none}
.field-label{font-size:13px;color:var(--c-text-muted);width:80px;flex-shrink:0}
.field-value{flex:1;font-size:14px;color:var(--c-text);word-break:break-all;font-family:'JetBrains Mono',monospace}
.field-action{font-size:12px;color:var(--c-accent);cursor:pointer;text-decoration:none;white-space:nowrap}
.field-action:hover{text-decoration:underline}

.edit-name-wrap{padding:14px 16px}
.edit-name-row{display:flex;gap:8px}
.edit-name-input{flex:1;border:1px solid var(--c-border);border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;background:var(--c-surface);color:var(--c-text);outline:none;transition:border-color 0.2s}
.edit-name-input:focus{border-color:var(--c-accent)}
.save-btn{background:var(--c-accent);color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;transition:opacity 0.2s}
.save-btn:hover{opacity:0.85}
.save-btn:disabled{opacity:0.4;cursor:default}
.save-status{font-size:12px;color:var(--c-text-muted);margin-top:8px;min-height:16px}

.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--c-border);border:1px solid var(--c-border);border-radius:12px;overflow:hidden}
.stat-cell{background:var(--c-bg);padding:16px;text-align:center}
.stat-num{font-size:24px;font-weight:800;color:var(--c-text);margin-bottom:2px}
.stat-lbl{font-size:12px;color:var(--c-text-muted)}

.activity-list{border:1px solid var(--c-border);border-radius:12px;overflow:hidden}
.activity-row{padding:12px 16px;border-bottom:1px solid var(--c-border);font-size:13px}
.activity-row:last-child{border-bottom:none}
.activity-input{color:var(--c-text);margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.activity-meta{font-size:11px;color:var(--c-text-muted);display:flex;gap:8px}
.activity-status{font-weight:600}
.status-completed{color:var(--c-success)}
.status-pending{color:var(--c-text-muted)}

.key-box{padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--c-text-muted);word-break:break-all;background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;cursor:pointer;transition:border-color 0.2s;user-select:all}
.key-box:hover{border-color:var(--c-accent)}
.key-warning{font-size:12px;color:var(--c-gold);margin-bottom:8px;display:flex;align-items:center;gap:6px}

.danger-btn{width:100%;background:none;border:1px solid var(--c-error);color:var(--c-error);border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.2s}
.danger-btn:hover{background:var(--c-error);color:#fff}

.no-identity{text-align:center;padding:60px 24px;color:var(--c-text-muted)}
.no-identity-title{font-size:18px;font-weight:700;color:var(--c-text);margin-bottom:8px}
.go-chat-btn{display:inline-block;margin-top:20px;background:var(--c-accent);color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px}

@media(max-width:480px){.profile-wrap{padding:20px 16px}.stat-grid{grid-template-columns:1fr 1fr}}
`

  const content = `<div class="profile-wrap" id="profile-wrap">
  <div class="no-identity" id="no-identity" style="display:none">
    <div style="font-size:48px;margin-bottom:16px">🔑</div>
    <div class="no-identity-title">No identity yet</div>
    <div>Go to Chat to generate your Nostr keypair</div>
    <a href="/chat" class="go-chat-btn">Open Chat →</a>
  </div>

  <div id="has-identity" style="display:none">
    <div class="profile-header">
      <div class="profile-avatar"><img id="profile-avatar-img" src="" alt="avatar"></div>
      <div class="profile-info">
        <div class="profile-name" id="profile-name-display">—</div>
        <div class="profile-pubkey" id="profile-pubkey" onclick="meApp.copyPubkey()" title="Click to copy">—</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Stats</div>
      <div class="stat-grid">
        <div class="stat-cell"><div class="stat-num" id="stat-sent">0</div><div class="stat-lbl">Messages sent</div></div>
        <div class="stat-cell"><div class="stat-num" id="stat-recv">0</div><div class="stat-lbl">Responses received</div></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Edit profile</div>
      <div class="section-card">
        <div class="edit-name-wrap">
          <div class="edit-name-row">
            <input class="edit-name-input" id="edit-name-input" placeholder="Your name" maxlength="40">
            <button class="save-btn" id="save-name-btn" onclick="meApp.saveName()">Save</button>
          </div>
          <div class="save-status" id="save-status"></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Recent activity</div>
      <div id="activity-list" class="activity-list">
        <div style="padding:20px;text-align:center;color:var(--c-text-muted);font-size:13px">Loading…</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Private key backup</div>
      <div class="key-warning">⚠ Keep this secret — anyone with this key controls your identity</div>
      <div class="key-box" id="key-box" onclick="meApp.copyKey()" title="Click to copy">
        <span id="key-hidden">Click to reveal</span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Danger zone</div>
      <button class="danger-btn" onclick="meApp.resetIdentity()">Reset identity — generate new keypair</button>
    </div>
  </div>
</div>`

  const scripts = `<script type="module">
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from 'https://esm.sh/nostr-tools@2.23.3/pure'
import { bytesToHex, hexToBytes } from 'https://esm.sh/nostr-tools@2.23.3/utils'
import { npubEncode } from 'https://esm.sh/nostr-tools@2.23.3/nip19'
import { Relay } from 'https://esm.sh/nostr-tools@2.23.3/relay'
${BEAM_AVATAR_JS}

const RELAY_URL = '${RELAY_URL}'
const HISTORY_KEY = 'chat_history'

function loadIdentity() {
  const pk = localStorage.getItem('nostr_privkey')
  if (!pk) return null
  try {
    const sk = hexToBytes(pk)
    const pubkey = getPublicKey(sk)
    const name = localStorage.getItem('nostr_name') || ''
    return { sk, pubkey, name }
  } catch { return null }
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

function minePoW(template, difficulty) {
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
      setTimeout(step, 0)
    }
    step()
  })
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.floor(s/60) + 'm ago'
  if (s < 86400) return Math.floor(s/3600) + 'h ago'
  return Math.floor(s/86400) + 'd ago'
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

let _identity = null
let _keyRevealed = false

async function init() {
  _identity = loadIdentity()
  if (!_identity) {
    document.getElementById('no-identity').style.display = 'block'
    return
  }
  document.getElementById('has-identity').style.display = 'block'

  const { pubkey, name } = _identity
  _identity.npub = npubEncode(pubkey)
  document.getElementById('profile-avatar-img').src = beamAvatar(pubkey, 72)
  document.getElementById('profile-name-display').textContent = name || 'Unnamed'
  document.getElementById('profile-pubkey').textContent = _identity.npub.slice(0, 20) + '…' + _identity.npub.slice(-6)
  document.getElementById('edit-name-input').value = name

  // Stats from chat history
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  document.getElementById('stat-sent').textContent = history.filter(m => m.role === 'user').length
  document.getElementById('stat-recv').textContent = history.filter(m => m.role === 'agent').length

  // Load activity from relay
  loadActivity(pubkey)
}

async function loadActivity(pubkey) {
  const list = document.getElementById('activity-list')
  try {
    const r = await Relay.connect(RELAY_URL)
    const events = []
    const results = new Map()

    await new Promise(resolve => {
      const sub = r.subscribe(
        [
          { kinds: [5100], authors: [pubkey], limit: 10 },
          { kinds: [6100], '#p': [pubkey], limit: 10 },
        ],
        {
          onevent(ev) {
            if (ev.kind === 5100) events.push(ev)
            if (ev.kind === 6100) {
              const reqId = ev.tags.find(t => t[0] === 'e')?.[1]
              if (reqId) results.set(reqId, ev)
            }
          },
          oneose() { sub.close(); resolve() }
        }
      )
      setTimeout(resolve, 5000)
    })
    r.close()

    if (!events.length) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--c-text-muted);font-size:13px">No activity yet</div>'
      return
    }

    events.sort((a, b) => b.created_at - a.created_at)
    list.innerHTML = events.map(ev => {
      const input = ev.tags.find(t => t[0] === 'i')?.[1] || ev.content || '—'
      const result = results.get(ev.id)
      const statusHtml = result
        ? '<span class="activity-status status-completed">✓ completed</span>'
        : '<span class="activity-status status-pending">⏳ pending</span>'
      return '<div class="activity-row">'
        + '<div class="activity-input">' + esc(input.slice(0, 120)) + '</div>'
        + '<div class="activity-meta">' + statusHtml + '<span>' + timeAgo(ev.created_at * 1000) + '</span></div>'
        + '</div>'
    }).join('')
  } catch(e) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--c-text-muted);font-size:13px">Could not load activity</div>'
  }
}

window.meApp = {
  copyPubkey() {
    if (!_identity) return
    navigator.clipboard.writeText(_identity.npub).catch(() => {})
    const el = document.getElementById('profile-pubkey')
    el.textContent = 'Copied!'
    setTimeout(() => {
      el.textContent = _identity.npub.slice(0, 20) + '\\u2026' + _identity.npub.slice(-6)
    }, 1500)
  },

  copyKey() {
    if (!_identity) return
    const box = document.getElementById('key-box')
    const hidden = document.getElementById('key-hidden')
    if (!_keyRevealed) {
      _keyRevealed = true
      hidden.textContent = bytesToHex(_identity.sk)
      return
    }
    navigator.clipboard.writeText(bytesToHex(_identity.sk)).catch(() => {})
    hidden.textContent = 'Copied!'
    setTimeout(() => { hidden.textContent = bytesToHex(_identity.sk) }, 1500)
  },

  async saveName() {
    if (!_identity) return
    const input = document.getElementById('edit-name-input')
    const name = input.value.trim()
    const btn = document.getElementById('save-name-btn')
    const status = document.getElementById('save-status')

    btn.disabled = true
    btn.textContent = 'Mining…'
    status.textContent = 'Mining proof of work (difficulty 20)…'

    try {
      const template = {
        kind: 0, pubkey: _identity.pubkey,
        content: JSON.stringify({ name: name || '', about: '2020117 user' }),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      }
      const mined = await minePoW(template, 20)
      btn.textContent = 'Publishing…'
      status.textContent = 'Publishing to relay…'
      const r = await Relay.connect(RELAY_URL)
      await r.publish(finalizeEvent(mined, _identity.sk))
      r.close()
      localStorage.setItem('nostr_name', name)
      _identity.name = name
      document.getElementById('profile-name-display').textContent = name || 'Unnamed'
      document.getElementById('profile-avatar-img').src = beamAvatar(_identity.pubkey, 72)
      status.textContent = '✓ Saved and published'
    } catch(e) {
      status.textContent = 'Error: ' + e.message
    } finally {
      btn.disabled = false
      btn.textContent = 'Save'
      setTimeout(() => { status.textContent = '' }, 3000)
    }
  },

  resetIdentity() {
    if (!confirm('This will delete your private key from this browser. You will get a new identity. Are you sure?')) return
    localStorage.removeItem('nostr_privkey')
    localStorage.removeItem('nostr_name')
    localStorage.removeItem('chat_history')
    localStorage.removeItem('chat_pending')
    location.href = '/chat'
  },
}

init()
</script>`

  return c.html(pageLayout({
    title: 'My Profile — 2020117',
    description: 'Your Nostr identity on the 2020117 network.',
    baseUrl,
    currentPath: '/me',
    lang,
    feedHeader: 'Profile',
    pageCSS,
    scripts,
  }, content))
})

export default router
