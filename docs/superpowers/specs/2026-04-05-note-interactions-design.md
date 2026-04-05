# Note Page Like & Reply Design

## Goal

Add interactive like (Kind 7) and reply (Kind 1) buttons to `/notes/:eventId` so logged-in users can interact with notes directly from the page.

## Architecture

All writes go through client-side Nostr event signing — consistent with landing.tsx composer and chat.tsx. No new HTTP endpoints. The page renders server-side as before; interaction logic lives in an inline `<script type="module">` block added to the `scripts` field alongside the existing non-module time-localizing script.

**Tech Stack:** nostr-tools v2 (same CDN import as landing.tsx), localStorage identity, `wss://relay.2020117.xyz`

---

## POW Requirements

Both Kind 7 (reaction) and Kind 1 (reply) require **POW difficulty 20**. In `relay/src/relay-do.ts`, `SOCIAL_KINDS = new Set([0, 1, 3, 6, 7, 16, 30023, 30078])` — Kind 7 is explicitly included, so the relay enforces POW 20 for all pubkeys regardless of registration. The like flow must mine POW 20 before publishing, same as replies.

---

## Components

### 1. Action Bar

Replaces / absorbs the existing `.interactions` div (which shows reaction/repost counts read-only). The new action bar renders in the same position — between `.note-content` and `<footer class="note-footer">` — and includes:

- **Like button**: `❤️ {count}` — filled red if already liked by current user, outlined otherwise
- **Reply button**: `💬 Reply` — clicking scrolls to / reveals the reply composer

Both buttons are always visible. Clicking while logged out shows a toast: **"请先去 Me 页面创建身份"** with a link to `/me`. The existing `.interactions` CSS classes are reused; the action bar replaces the purely-static interactions div.

**Server embeds on the action bar element:**
- `data-event-id="{eventId}"` — the note's event ID
- `data-author-pubkey="{notePubkey}"` — the note author's pubkey
- `data-reactors='["{pubkey1}","{pubkey2}",...]'` — JSON array of reactor pubkeys from DB (empty array `[]` if external note with no DB reactions)

### 2. Reply Composer

A `<div id="reply-composer">` inserted at the top of `.replies-section`, hidden by default (`display:none`). Structure:

```html
<div id="reply-composer" style="display:none;margin-bottom:20px">
  <textarea id="reply-text" placeholder="Write a reply…" rows="3"></textarea>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
    <button id="reply-cancel">Cancel</button>
    <button id="reply-send">Reply</button>
  </div>
  <div id="reply-status" style="font-size:13px;color:var(--c-text-muted)"></div>
</div>
```

### 3. Client-side JS (inline `<script type="module">`)

The module script defines its own `esc()` helper (cannot share with the outer non-module script). All relay interaction goes through a single `Relay.connect()` call, reused for both like and reply.

**Identity check helper:**
```js
function getIdentity() {
  const privHex = localStorage.getItem('nostr_privkey')
  if (!privHex) return null
  const pubkey = localStorage.getItem('nostr_pubkey') || bytesToHex(getPublicKey(hexToBytes(privHex)))
  return { privkey: hexToBytes(privHex), pubkey }
}
```

**Toast helper:** fixed-position yellow bar at top, auto-dismiss 3s.

**Like flow:**
1. `getIdentity()` → if null, show toast with `/me` link → return
2. Read `data-reactors` JSON from action bar → if current pubkey already in list → bail (already liked)
3. Disable like button, show mini spinner
4. Mine POW 20 on Kind 7 event: `{ kind: 7, content: "+", tags: [["e", eventId], ["p", authorPubkey]] }`
5. Connect relay → `relay.publish(event)`
6. On relay OK: fill ❤️, increment counter in DOM, append username/npub to reactor faces list, re-enable button
7. On relay rejection or network error: revert button state, show toast "发布失败，请重试"

**Reply flow:**
1. Reply button clicked → show `#reply-composer`, focus textarea
2. On Send: `getIdentity()` → if null, show toast → return
3. Validate textarea non-empty
4. Disable Send button, show "Mining POW…" in `#reply-status`
5. Mine POW 20 on Kind 1: `{ kind: 1, content: textarea.value, tags: [["e", eventId, "wss://relay.2020117.xyz", "reply"], ["p", authorPubkey]] }`
6. Update status → "Publishing…"
7. Connect relay → `relay.publish(event)`
8. On relay OK: prepend reply card to replies list (above existing replies), clear textarea, hide composer, show success toast
9. On relay rejection or error: re-enable Send, show error in `#reply-status`, do NOT prepend

**Optimistic reply card template** (self-contained, no server-side rendering):
```html
<div class="reply">
  <img src="{avatarSrc}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0">
  <div class="reply-body">
    <div class="reply-meta">
      <span class="reply-author-name"><a href="/agents/{username|npub}">{displayName}</a></span>
      <span class="reply-timestamp">just now</span>
    </div>
    <div class="reply-text">{escapedContent}</div>
  </div>
</div>
```
Author info comes from localStorage `nostr_name` (display name) and `nostr_pubkey`. Avatar falls back to `/api/avatar/{pubkey}`.

**No optimistic update for likes** — wait for relay confirmation before updating DOM (prevents phantom liked state on relay rejection).

---

## Data Flow

```
User clicks Like
  → check identity → (none) → toast → stop
  → check already-liked → stop if yes
  → mine POW 20
  → publish Kind 7
  → relay OK → update DOM
  → relay reject → show error

User clicks Reply → composer opens
  → types reply → clicks Send
  → check identity → (none) → toast → stop
  → mine POW 20
  → publish Kind 1
  → relay OK → prepend card, clear composer
  → relay reject → show error in composer (no DOM change)
```

---

## Constraints

- **0 HTTP writes** — only Nostr relay publishes
- **POW 20 for both Kind 7 and Kind 1** (relay SOCIAL_KINDS rule)
- Module script defines its own `esc()` — cannot access outer non-module script scope
- `data-reactors` is always a valid JSON array (empty `[]` for external/unknown notes)
- Relay connection created lazily on first interaction (not on page load)
- nostr-tools CDN import, same URL as landing.tsx
