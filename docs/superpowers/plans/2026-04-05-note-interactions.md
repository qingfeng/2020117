# Note Page Like & Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interactive ❤️ like (Kind 7) and 💬 reply (Kind 1) buttons to `/notes/:eventId` so logged-in users can publish Nostr events directly from the note page.

**Architecture:** All writes are client-side Nostr event signing via a `<script type="module">` injected into the `scripts` field of the page layout. The server-side `notes.tsx` embeds the note's `eventId`, `authorPubkey`, and a JSON list of existing reactor pubkeys as `data-*` attributes on the action bar element. The module script reads localStorage identity, mines POW 20, publishes to the relay, and updates the DOM on success.

**Tech Stack:** nostr-tools@2.23.3 (esm.sh CDN), `wss://relay.2020117.xyz`, localStorage (`nostr_privkey`, `nostr_pubkey`, `nostr_name`), Hono SSR (`src/pages/notes.tsx`)

---

## File Structure

- **Modify:** `src/pages/notes.tsx` — only file changed. Adds action bar HTML (with data attrs), reply composer HTML, CSS, and the module script block.

No new files needed. Everything is self-contained in the existing page.

---

### Task 1: Add action bar HTML + CSS (server-side, no JS yet)

**Files:**
- Modify: `src/pages/notes.tsx` (the `pageCSS` string and the `noteContent` string)

**Context:** The existing `.interactions` div (around line 315 in notes.tsx) is conditionally rendered only when `reactions.length > 0 || reposts.length > 0`. The new action bar replaces it and is always rendered. The action bar needs `data-event-id`, `data-author-pubkey`, and `data-reactors` attributes for the JS to read.

- [ ] **Step 1: Add CSS for action bar and reply composer to `pageCSS`**

In `src/pages/notes.tsx`, find the `pageCSS` constant (starts around line 266). Append these rules inside the template literal, before the closing backtick:

```css
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
```

- [ ] **Step 2: Replace the static `.interactions` div with the action bar**

In `noteContent`, find the existing reactions/reposts block (the `${(reactions.length > 0 || reposts.length > 0) ? ...}` conditional, around line 315). Replace it entirely with the action bar:

```js
// Build reactor pubkeys list for JS (for already-liked detection)
const reactorPubkeys = JSON.stringify(reactions.map(r => r.pubkey))
const likeCount = reactions.length
const isLiked = false // JS will check on load
```

Then in the HTML template where the old interactions block was, insert:

```html
<div class="action-bar"
  data-event-id="${esc(eventId)}"
  data-author-pubkey="${esc(notePubkey)}"
  data-reactors='${reactorPubkeys}'
  data-like-count="${likeCount}">
  <button class="action-btn" id="like-btn">
    ❤️ <span id="like-count">${likeCount}</span>
  </button>
  <button class="action-btn" id="reply-btn">
    💬 Reply
  </button>
</div>
```

- [ ] **Step 3: Add reply composer HTML at top of replies section**

In `noteContent`, find the replies section (the `<section class="replies-section"...>` block, around line 342). Insert the composer div immediately after the opening `<section>` tag and before the `<div class="replies-header">`:

```html
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
```

Also add the toast element just before the `</article>` closing tag (or anywhere in the HTML, it's fixed-positioned):

```html
<div class="toast-bar" id="toast-bar"></div>
```

- [ ] **Step 4: Build and verify page renders correctly (no JS yet)**

```bash
npm run dev
```

Open `http://localhost:8787/notes/<any-event-id>`. Verify:
- Action bar shows with ❤️ and 💬 buttons
- No JS errors in console
- Reply composer div exists in DOM but is hidden

- [ ] **Step 5: Commit**

```bash
git add src/pages/notes.tsx
git commit -m "feat(notes): add action bar and reply composer HTML/CSS"
```

---

### Task 2: Add the module script — identity, toast, like flow

**Files:**
- Modify: `src/pages/notes.tsx` (the `scripts` string, appending a new `<script type="module">` block)

**Context:** The existing `scripts` field contains a non-module `<script>` for time localization. Module scripts run in their own scope, so we define helpers like `esc()` from scratch. The like flow: read identity → check already-liked → mine POW 20 → publish Kind 7 → on relay OK update DOM.

- [ ] **Step 1: Append the module script to the `scripts` string in notes.tsx**

Find the `scripts` constant (around line 378):
```js
const scripts = `<script>document.querySelectorAll('time[datetime]')...`
```

Append a second script block after it (keep the existing one, add after):

```js
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

// Read page data from action bar data attributes
const actionBar = document.getElementById('like-btn')?.closest('.action-bar')
const EVENT_ID = actionBar?.dataset.eventId || ''
const AUTHOR_PUBKEY = actionBar?.dataset.authorPubkey || ''
let reactors = []
try { reactors = JSON.parse(actionBar?.dataset.reactors || '[]') } catch {}

const identity = loadIdentity()

// Pre-highlight like button if current user already liked
const likeBtn = document.getElementById('like-btn')
if (identity && reactors.includes(identity.pubkey)) {
  likeBtn?.classList.add('liked')
}

// Like button handler
likeBtn?.addEventListener('click', async () => {
  if (!identity) {
    showToast('请先去 <a href="/me" style="color:#713f12;text-decoration:underline">Me 页面</a> 创建身份')
    return
  }
  if (reactors.includes(identity.pubkey)) return  // already liked

  likeBtn.disabled = true
  const origText = likeBtn.innerHTML
  likeBtn.innerHTML = '⛏ Mining…'

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
      likeBtn.innerHTML = '⛏ ' + n + '…'
    })
    const event = finalizeEvent(mined, identity.sk)
    relay = await Relay.connect(RELAY_URL)
    await relay.publish(event)

    // Success: update DOM
    reactors.push(identity.pubkey)
    likeBtn.classList.add('liked')
    likeBtn.innerHTML = '❤️ <span id="like-count">' + reactors.length + '</span>'
  } catch (e) {
    showToast('发布失败，请重试')
    likeBtn.innerHTML = origText
  } finally {
    if (relay) relay.close()
    likeBtn.disabled = false
  }
})
</script>`
```

- [ ] **Step 2: Test like flow in dev**

```bash
npm run dev
```

1. Open a note page while **not** logged in → click ❤️ → toast appears with "请先去 Me 页面创建身份"
2. Log in via `/me`, return to note page → click ❤️ → button shows mining progress → changes to red ❤️ + incremented count on success
3. Click ❤️ again → nothing happens (already-liked guard)

- [ ] **Step 3: Commit**

```bash
git add src/pages/notes.tsx
git commit -m "feat(notes): add like button with POW 20 and relay publish"
```

---

### Task 3: Add reply flow to the module script

**Files:**
- Modify: `src/pages/notes.tsx` (extend the module script added in Task 2)

**Context:** Reply button toggles the `#reply-composer` div. Send button mines POW 20 for Kind 1 with `[e, eventId, relay, "reply"]` + `[p, authorPubkey]` tags. On relay OK, a reply card is prepended to the replies list. On failure, error shown in `#reply-status`, no DOM mutation.

The optimistic reply card must match the server-rendered `.reply` structure exactly:
```html
<div class="reply">
  <img src="..." style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="lazy">
  <div class="reply-body">
    <div class="reply-meta">
      <span class="reply-author-name"><a href="...">{name}</a></span>
      <span class="reply-timestamp">just now</span>
    </div>
    <div class="reply-text">{content}</div>
  </div>
</div>
```

- [ ] **Step 1: Add reply logic to the module script, after the like handler**

Inside the `<script type="module">` block (before the closing `</script>`), add:

```js
// Reply button: toggle composer
const replyBtn = document.getElementById('reply-btn')
const composer = document.getElementById('reply-composer')
const replyText = document.getElementById('reply-text')
const replyCancel = document.getElementById('reply-cancel')
const replySend = document.getElementById('reply-send')
const replyStatus = document.getElementById('reply-status')

replyBtn?.addEventListener('click', () => {
  if (!identity) {
    showToast('请先去 <a href="/me" style="color:#713f12;text-decoration:underline">Me 页面</a> 创建身份')
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
    showToast('请先去 <a href="/me" style="color:#713f12;text-decoration:underline">Me 页面</a> 创建身份')
    return
  }
  const text = replyText?.value.trim()
  if (!text) return

  replySend.disabled = true
  if (replyStatus) replyStatus.textContent = '⛏ Mining POW…'

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
      if (replyStatus) replyStatus.textContent = '⛏ ' + n + ' hashes…'
    })
    if (replyStatus) replyStatus.textContent = 'Publishing…'
    const event = finalizeEvent(mined, identity.sk)
    relay = await Relay.connect(RELAY_URL)
    await relay.publish(event)

    // Success: prepend reply card
    const repliesSection = document.querySelector('.replies-section')
    const firstReply = repliesSection?.querySelector('.reply')
    const noRepliesEl = repliesSection?.querySelector('.no-replies')
    if (noRepliesEl) noRepliesEl.remove()

    const avatarSrc = identity.pubkey
      ? '/api/avatar/' + encodeURIComponent(identity.name || identity.pubkey) + '?size=96'
      : ''
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

    // Update reply count badge
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

    // Clear and hide composer
    if (replyText) replyText.value = ''
    if (replyStatus) replyStatus.textContent = ''
    if (composer) composer.style.display = 'none'
    showToast('✓ Reply published')
  } catch (e) {
    if (replyStatus) replyStatus.textContent = '✗ ' + (e.message || 'Failed, try again')
  } finally {
    if (relay) relay.close()
    replySend.disabled = false
  }
})
```

- [ ] **Step 2: Test reply flow in dev**

```bash
npm run dev
```

1. Not logged in → click 💬 Reply → toast appears
2. Logged in → click 💬 Reply → composer opens with textarea focused
3. Type reply → click Reply → shows mining progress → on success, reply card prepends, "just now" timestamp, composer hides
4. Click Cancel → composer hides, textarea cleared
5. Empty textarea → click Reply → nothing happens (guard)
6. Verify "no replies yet" message disappears when first reply posted

- [ ] **Step 3: Commit**

```bash
git add src/pages/notes.tsx
git commit -m "feat(notes): add reply composer with POW 20 and post-relay card prepend"
```

---

### Task 4: Deploy and verify end-to-end

**Files:**
- No code changes — deploy and manual verification only

- [ ] **Step 1: Deploy**

```bash
npm run deploy
```

Expected output ends with: `Deployed 2020117 triggers`

- [ ] **Step 2: Verify on production**

Open any note page, e.g. `https://2020117.xyz/notes/<event-id>`.

Check:
- Action bar shows ❤️ count and 💬 Reply
- Not logged in: clicking either button shows yellow toast with /me link
- Logged in: clicking ❤️ mines POW, fills heart, increments count
- Logged in: clicking 💬 Reply opens composer; submitting mines POW, prepends reply card, hides composer
- Reply card shows your name and content correctly
- Relay at `wss://relay.2020117.xyz` accepts the events (no "pow: required difficulty" error in console)

- [ ] **Step 3: Push**

```bash
git push
```
