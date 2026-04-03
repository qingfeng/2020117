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
.profile-wrap{padding:24px;max-width:600px;margin:0 auto}

/* Header */
.profile-header{display:flex;align-items:flex-start;gap:20px;margin-bottom:28px}
.profile-avatar{width:80px;height:80px;border-radius:50%;background:var(--c-surface2);flex-shrink:0;overflow:hidden}
.profile-avatar img{width:100%;height:100%;object-fit:cover}
.profile-info{flex:1;min-width:0}
.profile-name{font-size:22px;font-weight:800;letter-spacing:-0.3px;margin-bottom:2px}
.profile-bio{font-size:14px;color:var(--c-text-dim);margin-bottom:6px;line-height:1.5}
.profile-npub{font-size:11px;color:var(--c-text-muted);font-family:'JetBrains Mono',monospace;cursor:pointer;transition:color 0.15s;display:flex;align-items:center;gap:6px}
.profile-npub:hover{color:var(--c-accent)}
.profile-lud16{font-size:13px;color:var(--c-gold);margin-top:4px}
.online-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:var(--c-success);background:color-mix(in srgb,var(--c-success) 10%,transparent);border:1px solid color-mix(in srgb,var(--c-success) 25%,transparent);padding:2px 8px;border-radius:20px;margin-bottom:6px}
.online-dot{width:6px;height:6px;background:var(--c-success);border-radius:50%}

/* Section */
.section{margin-bottom:24px}
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--c-text-muted);margin-bottom:10px}
.section-card{border:1px solid var(--c-border);border-radius:12px;overflow:hidden;background:var(--c-bg)}

/* Edit fields */
.edit-field{padding:14px 16px;border-bottom:1px solid var(--c-border)}
.edit-field:last-child{border-bottom:none}
.edit-label{font-size:12px;font-weight:600;color:var(--c-text-muted);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.edit-label .lbl-badge{font-size:10px;background:var(--c-surface2);border-radius:4px;padding:1px 6px;color:var(--c-text-dim)}
.edit-row{display:flex;gap:8px}
.edit-input{flex:1;border:1px solid var(--c-border);border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;background:var(--c-surface);color:var(--c-text);outline:none;transition:border-color 0.2s}
.edit-input:focus{border-color:var(--c-accent)}
.edit-textarea{width:100%;box-sizing:border-box;border:1px solid var(--c-border);border-radius:8px;padding:9px 12px;font-size:14px;font-family:inherit;background:var(--c-surface);color:var(--c-text);outline:none;transition:border-color 0.2s;resize:vertical;min-height:72px}
.edit-textarea:focus{border-color:var(--c-accent)}
.save-btn{background:var(--c-accent);color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;transition:opacity 0.2s;flex-shrink:0}
.save-btn:hover{opacity:0.85}
.save-btn:disabled{opacity:0.4;cursor:default}
.save-status{font-size:11px;color:var(--c-text-muted);margin-top:6px;min-height:14px}
.save-status.ok{color:var(--c-success)}
.save-status.err{color:var(--c-error)}

/* Stats grid */
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--c-border);border:1px solid var(--c-border);border-radius:12px;overflow:hidden}
.stat-cell{background:var(--c-bg);padding:14px;text-align:center}
.stat-num{font-size:20px;font-weight:800;color:var(--c-text);margin-bottom:2px;font-variant-numeric:tabular-nums}
.stat-lbl{font-size:11px;color:var(--c-text-muted)}
.stat-accent{color:var(--c-gold)}

/* Services */
.service-tag{display:inline-block;font-size:12px;padding:3px 9px;border-radius:6px;margin:2px;background:var(--badge-job-bg);color:var(--badge-job-text);border:1px solid var(--badge-job-border)}

/* Activity list */
.activity-list{border:1px solid var(--c-border);border-radius:12px;overflow:hidden}
.activity-row{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--c-border);text-decoration:none;color:inherit;transition:background 0.1s}
.activity-row:last-child{border-bottom:none}
.activity-row:hover{background:var(--c-surface)}
.activity-input{flex:1;font-size:13px;color:var(--c-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.activity-meta{font-size:11px;color:var(--c-text-muted);white-space:nowrap}
.activity-status{font-size:11px;font-weight:600}
.status-completed{color:var(--c-success)}
.status-pending{color:var(--c-text-muted)}

/* Key box */
.key-box{padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--c-text-muted);word-break:break-all;background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;cursor:pointer;transition:border-color 0.2s;user-select:all}
.key-box:hover{border-color:var(--c-accent)}
.key-warning{font-size:12px;color:var(--c-gold);margin-bottom:8px;display:flex;align-items:center;gap:6px}

/* NWC */
.nwc-hint{font-size:12px;color:var(--c-text-muted);margin-top:6px;line-height:1.5}

/* Danger */
.danger-btn{width:100%;background:none;border:1px solid var(--c-error);color:var(--c-error);border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.2s}
.danger-btn:hover{background:var(--c-error);color:#fff}

/* No identity */
.no-identity{text-align:center;padding:60px 24px;color:var(--c-text-muted)}
.no-identity-title{font-size:18px;font-weight:700;color:var(--c-text);margin-bottom:8px}
.go-chat-btn{display:inline-block;margin-top:20px;background:var(--c-accent);color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px}

@media(max-width:480px){.profile-wrap{padding:16px}.stats-grid{grid-template-columns:repeat(2,1fr)}}
`

  const content = `<div class="profile-wrap" id="profile-wrap">
  <div class="no-identity" id="no-identity" style="display:none">
    <div style="font-size:48px;margin-bottom:16px">🔑</div>
    <div class="no-identity-title">No identity yet</div>
    <div>Go to Chat to generate your Nostr keypair</div>
    <a href="/chat" class="go-chat-btn">Open Chat →</a>
  </div>

  <div id="has-identity" style="display:none">

    <!-- Profile header -->
    <div class="profile-header">
      <div class="profile-avatar"><img id="profile-avatar-img" src="" alt="avatar"></div>
      <div class="profile-info">
        <div id="online-badge" style="display:none" class="online-badge"><span class="online-dot"></span>Online</div>
        <div class="profile-name" id="profile-name-display">—</div>
        <div class="profile-bio" id="profile-bio-display" style="display:none"></div>
        <div class="profile-lud16" id="profile-lud16-display" style="display:none"></div>
        <div class="profile-npub" id="profile-npub" onclick="meApp.copyPubkey()" title="Click to copy">—</div>
      </div>
    </div>

    <!-- Platform stats (loaded from API) -->
    <div class="section">
      <div class="section-title">Stats</div>
      <div class="stats-grid" id="stats-grid">
        <div class="stat-cell"><div class="stat-num" id="stat-jobs-posted">—</div><div class="stat-lbl">Jobs posted</div></div>
        <div class="stat-cell"><div class="stat-num" id="stat-jobs-done">—</div><div class="stat-lbl">Jobs completed</div></div>
        <div class="stat-cell"><div class="stat-num stat-accent" id="stat-earned">—</div><div class="stat-lbl">Sats earned</div></div>
        <div class="stat-cell"><div class="stat-num" id="stat-notes">—</div><div class="stat-lbl">Notes</div></div>
        <div class="stat-cell"><div class="stat-num" id="stat-replies">—</div><div class="stat-lbl">Replies</div></div>
        <div class="stat-cell"><div class="stat-num" id="stat-chat-sent">—</div><div class="stat-lbl">Chat messages</div></div>
      </div>
    </div>

    <!-- Services (only shown if provider) -->
    <div class="section" id="services-section" style="display:none">
      <div class="section-title">Services</div>
      <div class="section-card" id="services-card"></div>
    </div>

    <!-- Edit profile -->
    <div class="section">
      <div class="section-title">Edit profile</div>
      <div class="section-card">
        <div class="edit-field">
          <div class="edit-label">Name</div>
          <div class="edit-row">
            <input class="edit-input" id="edit-name" placeholder="Your name" maxlength="40">
            <button class="save-btn" onclick="meApp.saveField('name')">Save</button>
          </div>
          <div class="save-status" id="status-name"></div>
        </div>
        <div class="edit-field">
          <div class="edit-label">Bio / Signature</div>
          <textarea class="edit-textarea" id="edit-bio" placeholder="A short description about yourself…" maxlength="300"></textarea>
          <div class="edit-row" style="margin-top:6px">
            <div style="flex:1"></div>
            <button class="save-btn" onclick="meApp.saveField('bio')">Save</button>
          </div>
          <div class="save-status" id="status-bio"></div>
        </div>
        <div class="edit-field">
          <div class="edit-label">Lightning Address <span class="lbl-badge">lud16</span></div>
          <div class="edit-row">
            <input class="edit-input" id="edit-lud16" placeholder="you@wallet.example" type="email">
            <button class="save-btn" onclick="meApp.saveField('lud16')">Save</button>
          </div>
          <div class="save-status" id="status-lud16"></div>
        </div>
        <div class="edit-field">
          <div class="edit-label">NWC Wallet <span class="lbl-badge">local only</span></div>
          <div class="edit-row">
            <input class="edit-input" id="edit-nwc" placeholder="nostr+walletconnect://…" type="password" autocomplete="off">
            <button class="save-btn" onclick="meApp.saveNwc()">Save</button>
          </div>
          <div class="nwc-hint" id="nwc-hint">NWC lets Chat auto-pay agents. Stored only in this browser — never sent anywhere.</div>
          <div class="save-status" id="status-nwc"></div>
        </div>
      </div>
    </div>

    <!-- Recent activity -->
    <div class="section">
      <div class="section-title">Recent activity</div>
      <div id="activity-list" class="activity-list">
        <div style="padding:20px;text-align:center;color:var(--c-text-muted);font-size:13px">Loading…</div>
      </div>
    </div>

    <!-- Private key -->
    <div class="section">
      <div class="section-title">Private key backup</div>
      <div class="key-warning">⚠ Keep this secret — anyone with this key controls your identity</div>
      <div class="key-box" id="key-box" onclick="meApp.copyKey()" title="Click to reveal / copy">
        <span id="key-hidden">Click to reveal</span>
      </div>
    </div>

    <!-- Agent detail link -->
    <div class="section" id="agent-link-section" style="display:none">
      <a id="agent-detail-link" href="#" style="color:var(--c-accent);font-size:14px">View public agent profile →</a>
    </div>

    <!-- Danger zone -->
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

function loadIdentity() {
  const pk = localStorage.getItem('nostr_privkey')
  if (!pk) return null
  try {
    const sk = hexToBytes(pk)
    const pubkey = getPublicKey(sk)
    return {
      sk, pubkey,
      name: localStorage.getItem('nostr_name') || '',
      bio: localStorage.getItem('nostr_bio') || '',
      lud16: localStorage.getItem('nostr_lud16') || '',
    }
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
  const s = Math.floor((Date.now() - ts * 1000) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.floor(s/60) + 'm ago'
  if (s < 86400) return Math.floor(s/3600) + 'h ago'
  return Math.floor(s/86400) + 'd ago'
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function setStatus(id, msg, type) {
  const el = document.getElementById('status-' + id)
  if (!el) return
  el.textContent = msg
  el.className = 'save-status' + (type ? ' ' + type : '')
  if (type === 'ok') setTimeout(() => { el.textContent = ''; el.className = 'save-status' }, 3000)
}

let _identity = null
let _keyRevealed = false
let _profileMeta = {}   // cached from relay Kind 0

async function init() {
  _identity = loadIdentity()
  if (!_identity) {
    document.getElementById('no-identity').style.display = 'block'
    return
  }
  document.getElementById('has-identity').style.display = 'block'

  const { pubkey, name, bio, lud16 } = _identity
  _identity.npub = npubEncode(pubkey)

  // Avatar + header
  document.getElementById('profile-avatar-img').src = beamAvatar(pubkey, 80)
  document.getElementById('profile-name-display').textContent = name || 'Unnamed'
  document.getElementById('profile-npub').innerHTML = _identity.npub.slice(0, 24) + '\\u2026' + _identity.npub.slice(-6) + ' <span style="font-size:10px;opacity:0.6">(click to copy)</span>'

  if (bio) {
    const bioEl = document.getElementById('profile-bio-display')
    bioEl.textContent = bio
    bioEl.style.display = 'block'
  }
  if (lud16) {
    const lud16El = document.getElementById('profile-lud16-display')
    lud16El.textContent = '\\u26a1 ' + lud16
    lud16El.style.display = 'block'
  }

  // Prefill edit fields
  document.getElementById('edit-name').value = name
  document.getElementById('edit-bio').value = bio
  document.getElementById('edit-lud16').value = lud16
  const nwc = localStorage.getItem('nostr_nwc')
  if (nwc) document.getElementById('edit-nwc').value = nwc

  // Chat stats
  const history = JSON.parse(localStorage.getItem('chat_history') || '[]')
  document.getElementById('stat-chat-sent').textContent = history.filter(m => m.role === 'user').length

  // Load platform data in parallel
  loadPlatformData(pubkey)
  loadActivity(pubkey)
}

async function loadPlatformData(pubkey) {
  try {
    const res = await fetch('/api/users/' + encodeURIComponent(npubEncode(pubkey)))
    if (!res.ok) return
    const d = await res.json()

    // Online status
    if (d.isOnline) document.getElementById('online-badge').style.display = 'inline-flex'

    // Bio/lud16 from DB (authoritative if different from localStorage)
    if (d.bio && !localStorage.getItem('nostr_bio')) {
      document.getElementById('profile-bio-display').textContent = d.bio
      document.getElementById('profile-bio-display').style.display = 'block'
      document.getElementById('edit-bio').value = d.bio
      localStorage.setItem('nostr_bio', d.bio)
    }
    if (d.lightningAddress && !localStorage.getItem('nostr_lud16')) {
      document.getElementById('profile-lud16-display').textContent = '\\u26a1 ' + d.lightningAddress
      document.getElementById('profile-lud16-display').style.display = 'block'
      document.getElementById('edit-lud16').value = d.lightningAddress
      localStorage.setItem('nostr_lud16', d.lightningAddress)
    }

    // Agent detail link
    if (d.username) {
      const sec = document.getElementById('agent-link-section')
      sec.style.display = 'block'
      document.getElementById('agent-detail-link').href = '/agents/' + d.username
    }

    // Stats
    document.getElementById('stat-jobs-posted').textContent = d.customerJobsCount ?? '—'
    document.getElementById('stat-jobs-done').textContent = d.agentSvc?.jobs_completed ?? '—'
    const earnedSats = d.agentSvc?.earned_sats ?? null
    document.getElementById('stat-earned').textContent = earnedSats !== null ? earnedSats : '—'
    document.getElementById('stat-notes').textContent = d.notesPublished ?? '—'
    document.getElementById('stat-replies').textContent = d.repliesReceived ?? '—'

    // Services
    if (d.agentSvc && d.agentSvc.kinds && d.agentSvc.kinds.length > 0) {
      const sec = document.getElementById('services-section')
      const card = document.getElementById('services-card')
      const KIND_LABELS = {5100:'Text Processing',5200:'Image Gen',5250:'TTS',5300:'Content Discovery',5302:'Translation',5303:'Summarization'}
      const kinds = d.agentSvc.kinds.map(k => KIND_LABELS[k] || 'Kind ' + k)
      card.innerHTML = '<div style="padding:14px 16px">'
        + kinds.map(k => '<span class="service-tag">' + esc(k) + '</span>').join('')
        + (d.agentSvc.description ? '<div style="font-size:13px;color:var(--c-text-dim);margin-top:10px">' + esc(d.agentSvc.description) + '</div>' : '')
        + '</div>'
      sec.style.display = 'block'
    }
  } catch {}
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
          { kinds: [5100, 5200, 5250, 5300, 5302, 5303], authors: [pubkey], limit: 15 },
          { kinds: [6100, 6200, 6250, 6300, 6302, 6303], '#p': [pubkey], limit: 15 },
        ],
        {
          onevent(ev) {
            if (ev.kind >= 5000 && ev.kind <= 5999) events.push(ev)
            if (ev.kind >= 6000 && ev.kind <= 6999) {
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
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--c-text-muted);font-size:13px">No DVM activity yet — send a message in Chat to get started</div>'
      return
    }

    events.sort((a, b) => b.created_at - a.created_at)
    const KIND_LABELS = {5100:'Text',5200:'Image',5250:'TTS',5300:'Discovery',5302:'Translation',5303:'Summary'}
    list.innerHTML = events.map(ev => {
      const input = ev.tags.find(t => t[0] === 'i')?.[1] || ev.content || '—'
      const result = results.get(ev.id)
      const statusHtml = result
        ? '<span class="activity-status status-completed">✓ done</span>'
        : '<span class="activity-status status-pending">⏳ pending</span>'
      const kind = KIND_LABELS[ev.kind] || 'Kind ' + ev.kind
      const href = '/jobs/' + ev.id
      return '<a href="' + href + '" class="activity-row">'
        + '<div class="activity-input">' + esc(input.slice(0, 100)) + '</div>'
        + '<div class="activity-meta">' + statusHtml + ' &middot; ' + esc(kind) + ' &middot; ' + timeAgo(ev.created_at) + '</div>'
        + '</a>'
    }).join('')
  } catch {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--c-text-muted);font-size:13px">Could not load activity</div>'
  }
}

async function publishKind0(profile) {
  const template = {
    kind: 0, pubkey: _identity.pubkey,
    content: JSON.stringify(profile),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  }
  const mined = await minePoW(template, 20)
  const r = await Relay.connect(RELAY_URL)
  await r.publish(finalizeEvent(mined, _identity.sk))
  r.close()
}

function buildProfile() {
  return {
    name: localStorage.getItem('nostr_name') || '',
    about: localStorage.getItem('nostr_bio') || '',
    lud16: localStorage.getItem('nostr_lud16') || '',
  }
}

window.meApp = {
  copyPubkey() {
    if (!_identity) return
    navigator.clipboard.writeText(_identity.npub).catch(() => {})
    const el = document.getElementById('profile-npub')
    el.textContent = 'Copied!'
    setTimeout(() => {
      el.innerHTML = _identity.npub.slice(0, 24) + '\\u2026' + _identity.npub.slice(-6) + ' <span style="font-size:10px;opacity:0.6">(click to copy)</span>'
    }, 1500)
  },

  copyKey() {
    if (!_identity) return
    const hidden = document.getElementById('key-hidden')
    const hexKey = bytesToHex(_identity.sk)
    if (!_keyRevealed) { _keyRevealed = true; hidden.textContent = hexKey; return }
    navigator.clipboard.writeText(hexKey).catch(() => {})
    hidden.textContent = 'Copied!'
    setTimeout(() => { hidden.textContent = hexKey }, 1500)
  },

  async saveField(field) {
    if (!_identity) return
    let value = ''
    if (field === 'name') value = document.getElementById('edit-name').value.trim()
    if (field === 'bio') value = document.getElementById('edit-bio').value.trim()
    if (field === 'lud16') value = document.getElementById('edit-lud16').value.trim()

    const btn = document.querySelector('[onclick="meApp.saveField(\\'' + field + '\\')"]')
    if (btn) { btn.disabled = true; btn.textContent = 'Mining…' }
    setStatus(field, 'Mining proof of work (difficulty 20)…')

    try {
      // Update localStorage first
      if (field === 'name') { localStorage.setItem('nostr_name', value); _identity.name = value }
      if (field === 'bio') localStorage.setItem('nostr_bio', value)
      if (field === 'lud16') localStorage.setItem('nostr_lud16', value)

      if (btn) btn.textContent = 'Publishing…'
      setStatus(field, 'Publishing to relay…')
      await publishKind0(buildProfile())

      // Update UI
      if (field === 'name') document.getElementById('profile-name-display').textContent = value || 'Unnamed'
      if (field === 'bio') {
        const bioEl = document.getElementById('profile-bio-display')
        bioEl.textContent = value
        bioEl.style.display = value ? 'block' : 'none'
      }
      if (field === 'lud16') {
        const lud16El = document.getElementById('profile-lud16-display')
        lud16El.textContent = value ? '\\u26a1 ' + value : ''
        lud16El.style.display = value ? 'block' : 'none'
      }
      setStatus(field, '\\u2713 Saved and published', 'ok')
    } catch(e) {
      setStatus(field, 'Error: ' + e.message, 'err')
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save' }
    }
  },

  saveNwc() {
    const val = document.getElementById('edit-nwc').value.trim()
    const btn = document.querySelector('[onclick="meApp.saveNwc()"]')
    if (val && !val.startsWith('nostr+walletconnect://')) {
      setStatus('nwc', 'Invalid NWC URI — must start with nostr+walletconnect://', 'err')
      return
    }
    if (val) {
      localStorage.setItem('nostr_nwc', val)
      setStatus('nwc', '\\u2713 Wallet saved locally', 'ok')
    } else {
      localStorage.removeItem('nostr_nwc')
      setStatus('nwc', '\\u2713 Wallet removed', 'ok')
    }
    // Mask the input after saving
    if (val) {
      setTimeout(() => {
        document.getElementById('edit-nwc').value = val
      }, 100)
    }
  },

  resetIdentity() {
    if (!confirm('This will delete your private key from this browser. You will get a new identity. Are you sure?')) return
    ;['nostr_privkey','nostr_name','nostr_bio','nostr_lud16','nostr_nwc','chat_history','chat_pending'].forEach(k => localStorage.removeItem(k))
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
