# Timeline Compose Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a note composer to the timeline (landing) page so logged-in users can post Kind 1 Nostr notes directly from the web.

**Architecture:** Add CSS + HTML for a composer box above the filter tabs in `landing.tsx`. Add a separate `<script type="module">` block (non-disruptive to existing `<script>`) that reads identity from localStorage, signs Kind 1 events with nostr-tools, publishes to relay, and calls the existing `loadNewPosts()` to refresh the feed. No server changes needed.

**Tech Stack:** Hono JSX (server-side render), inline ESM via esm.sh (nostr-tools@2.23.3), localStorage identity (same pattern as me.tsx and chat.tsx).

---

### Task 1: CSS for composer

**Files:**
- Modify: `src/pages/landing.tsx` — `pageCSS` string (around line 87)

- [ ] **Step 1: Add composer CSS to `pageCSS`**

Append to the `pageCSS` template string (before the closing backtick):

```css
/* Composer */
#composer{display:none;gap:12px;padding:16px 20px;border-bottom:1px solid var(--c-border);align-items:flex-start}
#composer-right{flex:1;display:flex;flex-direction:column;gap:8px}
#composer-text{width:100%;min-height:72px;resize:vertical;border:1px solid var(--c-border);border-radius:8px;padding:10px 12px;font-size:15px;font-family:inherit;background:var(--c-bg);color:var(--c-text);line-height:1.5;transition:border-color 0.15s;box-sizing:border-box}
#composer-text:focus{outline:none;border-color:var(--c-accent)}
#composer-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px}
#composer-status{font-size:13px;color:var(--c-text-muted);flex:1}
#composer-send{padding:7px 18px;background:var(--c-accent);color:#fff;border:none;border-radius:20px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:opacity 0.15s}
#composer-send:hover{opacity:0.85}
#composer-send:disabled{opacity:0.5;cursor:default}
#composer-login{display:none;padding:14px 20px;border-bottom:1px solid var(--c-border);font-size:14px;color:var(--c-text-muted)}
#composer-login a{color:var(--c-accent);text-decoration:none}
#composer-login a:hover{text-decoration:underline}
```

- [ ] **Step 2: Visual check**

No test here — just ensure no syntax errors. Run:
```bash
npm run dev
```
Open `http://localhost:8787` — page should load without errors (composer not yet visible).

---

### Task 2: HTML for composer

**Files:**
- Modify: `src/pages/landing.tsx` — `content` string (around line 131)

- [ ] **Step 1: Insert composer HTML before the filter tabs**

Replace the `content` string opening:

```js
const content = `<div id="composer">
  <img id="composer-avatar" class="post-avatar" src="" alt="" loading="lazy">
  <div id="composer-right">
    <textarea id="composer-text" placeholder="What's on your mind?" rows="3"></textarea>
    <div class="composer-footer">
      <span id="composer-status"></span>
      <button id="composer-send">Post</button>
    </div>
  </div>
</div>
<div id="composer-login">
  <a href="/me">→ Set up identity on /me to post notes</a>
</div>
<div class="feed-tabs-wrap">
  ...existing tabs...
```

Keep everything after `<div class="feed-tabs-wrap">` unchanged.

- [ ] **Step 2: Verify HTML renders**

Run `npm run dev`, open `http://localhost:8787` — page loads, no visible composer yet (display:none).

---

### Task 3: Module script — identity check + publish

**Files:**
- Modify: `src/pages/landing.tsx` — append a second script block after the closing `</script>` of the existing script

- [ ] **Step 1: Append module script to `scripts` string**

After the existing `</script>` in the `scripts` template literal, append:

```js
<script type="module">
import { getPublicKey, finalizeEvent } from 'https://esm.sh/nostr-tools@2.23.3/pure'
import { Relay } from 'https://esm.sh/nostr-tools@2.23.3/relay'

const RELAY_URL = 'wss://relay.2020117.xyz'

function loadIdentity() {
  const pk = localStorage.getItem('nostr_privkey')
  if (!pk) return null
  try {
    const sk = Uint8Array.from(pk.match(/.{2}/g).map(b => parseInt(b, 16)))
    const pubkey = localStorage.getItem('nostr_pubkey') || ''
    const name = localStorage.getItem('nostr_name') || ''
    const avatarUrl = localStorage.getItem('nostr_avatar') || ''
    return { sk, pubkey, name, avatarUrl }
  } catch { return null }
}

const identity = loadIdentity()
const composer = document.getElementById('composer')
const loginPrompt = document.getElementById('composer-login')

if (identity) {
  composer.style.display = 'flex'
  const avatarEl = document.getElementById('composer-avatar')
  // reuse beamAvatar from the non-module script (global)
  avatarEl.src = identity.avatarUrl || window.beamAvatar(identity.pubkey || 'x', 46)
  avatarEl.alt = identity.name
} else {
  loginPrompt.style.display = 'block'
}

async function publishNote(text) {
  const sendBtn = document.getElementById('composer-send')
  const statusEl = document.getElementById('composer-status')
  const textarea = document.getElementById('composer-text')

  sendBtn.disabled = true
  sendBtn.textContent = 'Posting…'
  statusEl.textContent = ''

  try {
    const event = finalizeEvent({
      kind: 1,
      content: text.trim(),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    }, identity.sk)

    const relay = await Relay.connect(RELAY_URL)
    await relay.publish(event)
    relay.close()

    textarea.value = ''
    statusEl.textContent = '✓ Posted'
    setTimeout(() => { statusEl.textContent = '' }, 3000)
    // Refresh feed — loadNewPosts is defined in the non-module script
    if (typeof window.loadNewPosts === 'function') window.loadNewPosts()
  } catch (e) {
    statusEl.textContent = '✗ ' + (e.message || 'Failed')
  } finally {
    sendBtn.disabled = false
    sendBtn.textContent = 'Post'
  }
}

if (identity) {
  document.getElementById('composer-send').addEventListener('click', () => {
    const text = document.getElementById('composer-text').value.trim()
    if (!text) return
    publishNote(text)
  })

  document.getElementById('composer-text').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const text = e.target.value.trim()
      if (!text) return
      publishNote(text)
    }
  })
}
</script>
```

- [ ] **Step 2: Make `loadNewPosts` accessible to module script**

In the existing non-module `<script>`, expose `loadNewPosts` on `window`. Find:
```js
function loadNewPosts() {
```
Change to:
```js
window.loadNewPosts = function loadNewPosts() {
```

- [ ] **Step 3: Make `beamAvatar` accessible**

`BEAM_AVATAR_JS` already defines `beamAvatar` as a global function (non-module script). Verify by checking `src/lib/avatar.ts` — it should export `BEAM_AVATAR_JS` as a string that defines `function beamAvatar(...)`. The module script accesses it as `window.beamAvatar(...)`.

- [ ] **Step 4: Manual test**

1. Open `http://localhost:8787`
2. Without identity in localStorage: login prompt visible, no composer
3. Add identity: open DevTools console, run:
   ```js
   localStorage.setItem('nostr_privkey', '...')  // any 64-char hex
   ```
   Reload — composer appears with avatar
4. Type a note, click Post (or Cmd+Enter) — "Posting…" → "✓ Posted" → feed refreshes

- [ ] **Step 5: Commit**

```bash
git add src/pages/landing.tsx
git commit -m "feat: add note composer to timeline page"
```

---

### Task 4: Deploy

- [ ] **Step 1: Deploy**

```bash
npm run deploy
```

- [ ] **Step 2: Smoke test on production**

Open `https://2020117.xyz`, verify composer visible (if logged in via /me), post a test note, confirm it appears in feed within 30s.
