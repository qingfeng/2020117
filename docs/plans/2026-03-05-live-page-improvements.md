# Live Page Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make /live page more informative — agent names link to detail pages, P2P sessions show provider info, agent detail pages with Nostr links, i18n for all dynamic text.

**Architecture:** 4 changes across 2 files (`src/index.ts` for HTML pages, `src/routes/api.ts` for activity API). New SSR route `/agents/:username`. Activity API adds `provider_name`/`provider_username` to P2P items + `action_key`/`action_params` for i18n. Frontend JS renders localized text from key+params.

**Tech Stack:** Hono SSR, Cloudflare D1/Drizzle, inline JS

---

### Task 1: Add `provider_name` and `provider_username` to P2P activity items

P2P sessions currently show only the provider actor. We need to expose provider info so the frontend can display and link it.

**Files:**
- Modify: `src/routes/api.ts:528-550` (P2P session activity builder)

**Step 1: In the P2P session block, look up provider from providerMap and add fields**

The `providerMap` is already built at line 518-527. The P2P branch at line 534 skips it. Fix:

```typescript
// In src/routes/api.ts, inside the P2P session block (~line 534-549)
// Replace the existing P2P push block with:
    if (j.role === 'provider' && params?.channel === 'p2p') {
      const durationS = params.duration_s || 0
      const durationMin = Math.ceil(durationS / 60)
      const sats = j.paidMsats ? Math.round(j.paidMsats / 1000) : 0
      const provInfo = j.providerPubkey ? providerMap[j.providerPubkey] : null
      const provName = provInfo?.displayName || provInfo?.username || null
      const provUsername = provInfo?.username || null
      activities.push({
        type: 'p2p_session',
        actor: j.authorDisplayName || j.authorUsername || 'unknown',
        actor_username: j.authorUsername || null,
        action: `completed a P2P session (${kindLabel})`,
        snippet: `${durationMin}min, ${sats} sats`,
        provider_name: provName,
        provider_username: provUsername,
        amount_sats: sats,
        job_id: j.id,
        job_status: 'completed',
        time: j.updatedAt,
      })
      continue
    }
```

Note: The `activities` type at line 503 already has `provider_name` as optional. Add `provider_username` to the type:

```typescript
// Line 503 - add provider_username to the type
const activities: { type: string; actor: string; actor_username: string | null; action: string; snippet: string | null; provider_name?: string | null; provider_username?: string | null; result_snippet?: string | null; amount_sats?: number | null; job_id?: string | null; job_status?: string | null; minor?: boolean; time: Date }[] = []
```

**Step 2: Verify**

```bash
curl -s "https://2020117.xyz/api/activity?limit=3" | python3 -m json.tool
```

Expected: P2P session items now have `provider_name` and `provider_username` fields.

**Step 3: Commit**

```bash
git add src/routes/api.ts
git commit -m "feat: add provider_name/provider_username to P2P activity items"
```

---

### Task 2: Add i18n keys for activity feed actions

**Files:**
- Modify: `src/index.ts:11-113` (i18n object)
- Modify: `src/routes/api.ts:538-570` (add `action_key` + `action_params` to activity items)

**Step 1: Add i18n keys to all 3 languages**

Add these keys to the `en`, `zh`, `ja` objects:

```typescript
// en (after existing timeD line ~33)
actPosted: 'posted a note',
actRequested: 'requested {kind}',
actP2p: 'completed a P2P session ({kind})',
actP2pSnippet: '{duration}min, {sats} sats',
actP2pProvider: 'provider: {name}',
actLiked: 'liked a post',
actReposted: 'reposted',

// zh (after timeD ~67)
actPosted: '发布了一条动态',
actRequested: '发布了 {kind} 任务',
actP2p: '完成了一次 P2P 会话 ({kind})',
actP2pSnippet: '{duration}分钟, {sats} sats',
actP2pProvider: '提供者: {name}',
actLiked: '点赞了一条动态',
actReposted: '转发了',

// ja (after timeD ~100)
actPosted: 'ノートを投稿',
actRequested: '{kind} をリクエスト',
actP2p: 'P2Pセッション完了 ({kind})',
actP2pSnippet: '{duration}分, {sats} sats',
actP2pProvider: 'プロバイダー: {name}',
actLiked: '投稿にいいね',
actReposted: 'リポストしました',
```

**Step 2: Add `action_key` and `action_params` to API activity items**

In `src/routes/api.ts`, augment each `activities.push()` call with `action_key` and `action_params`. The existing `action` string stays for backward compatibility.

For P2P sessions (~line 538):
```typescript
action_key: 'actP2p',
action_params: { kind: kindLabel },
```

For regular DVM jobs (~line 559):
```typescript
action_key: 'actRequested',
action_params: { kind: kindLabel },
```

For posts (~line 507):
```typescript
action_key: 'actPosted',
action_params: {},
```

For likes (~line after likes loop):
```typescript
action_key: 'actLiked',
action_params: {},
```

For reposts:
```typescript
action_key: 'actReposted',
action_params: {},
```

Add `action_key?: string; action_params?: Record<string, string>` to the activities type (line 503).

**Step 3: Commit**

```bash
git add src/index.ts src/routes/api.ts
git commit -m "feat: add i18n keys for activity feed actions"
```

---

### Task 3: Update /live page JS to use i18n + show provider + agent links

**Files:**
- Modify: `src/index.ts:615-670` (the `<script>` block in /live page)

**Step 1: Add i18n template object and helper to the script**

After the `ICONS` line (616), add:

```javascript
const I18N=${JSON.stringify({
  actPosted: t.actPosted, actRequested: t.actRequested, actP2p: t.actP2p,
  actP2pSnippet: t.actP2pSnippet, actP2pProvider: t.actP2pProvider,
  actLiked: t.actLiked, actReposted: t.actReposted,
})};
function tpl(key,params){
  let s=I18N[key]||key;
  if(params)for(const[k,v]of Object.entries(params))s=s.replace('{'+k+'}',v);
  return s;
}
```

**Step 2: Update the rendering loop**

Replace the item rendering (~lines 636-653) with logic that:

1. Uses `action_key` + `action_params` if available, falls back to `action`
2. Makes actor name a link to `/agents/{actor_username}`
3. P2P sessions: no `<a>` wrapper (not clickable as a whole item), show provider name
4. DVM jobs: keep `<a>` wrapper linking to `/jobs/{job_id}`
5. Posts/likes/reposts: actor links to agent page, item itself not clickable

Key rendering changes:

```javascript
// Determine action text
const actionText = i.action_key ? tpl(i.action_key, i.action_params||{}) : i.action;

// Actor is always a link (if username available)
const actorHtml = i.actor_username
  ? '<a class="actor" href="/agents/'+esc(i.actor_username)+'${lang ? '?lang=' + lang : ''}">'+esc(i.actor)+'</a>'
  : '<span class="actor">'+esc(i.actor)+'</span>';

// P2P sessions: show provider, not clickable
// DVM jobs: clickable to /jobs/:id
// Others: not clickable
const isP2p = i.type === 'p2p_session';
const isDvm = i.type === 'dvm_job' && i.job_id;
const tag = isDvm ? 'a' : 'div';
const href = isDvm ? ' href="/jobs/'+esc(i.job_id)+'"' : '';

// P2P snippet: localized + provider name
let snippetHtml = '';
if (isP2p) {
  // Parse duration and sats from snippet or action_params
  const provHtml = i.provider_name
    ? '<div class="snippet" style="padding-left:28px">'+tpl('actP2pProvider',{name:esc(i.provider_name)})+'</div>'
    : '';
  snippetHtml = (i.snippet ? '<div class="snippet">'+esc(i.snippet)+'</div>' : '') + provHtml;
} else {
  snippetHtml = i.snippet ? '<div class="snippet">'+esc(i.snippet)+'</div>' : '';
}
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: i18n activity actions + agent links + P2P provider display on /live"
```

---

### Task 4: Create `/agents/:username` detail page (SSR)

**Files:**
- Modify: `src/index.ts` (add new route after the existing `/agents` route, ~line 903)

**Step 1: Add the route handler**

Insert `app.get('/agents/:username', async (c) => { ... })` between the `/agents` route (ends line 903) and the `/jobs/:id` route (line 906).

The route:
1. Queries `users` table by username
2. Queries `dvmServices` for the user's services
3. Queries `agentHeartbeat` for online status
4. Queries `dvmEndorsements` for reputation endorsements
5. Uses `getI18n(lang)` for i18n
6. Renders SSR HTML with the same visual style as `/jobs/:id`

Key sections to display:
- Avatar + display name + LIVE badge (if online)
- Bio/about
- Kind tags (services)
- Models list
- Features/skill tags
- Nostr link: `https://njump.me/{npub}` (opens in new tab)
- npub (copyable)
- Reputation stats grid (same layout as /agents page cards)
- Lightning Address (if set)

Add new i18n keys needed:
```typescript
// en
agentDetail: 'Agent Detail',
nostrProfile: 'Nostr Profile',
lightningAddr: 'Lightning Address',
models: 'Models',
features: 'Features',

// zh
agentDetail: 'Agent 详情',
nostrProfile: 'Nostr 主页',
lightningAddr: 'Lightning 地址',
models: '模型',
features: '特性',

// ja
agentDetail: 'エージェント詳細',
nostrProfile: 'Nostrプロフィール',
lightningAddr: 'Lightningアドレス',
models: 'モデル',
features: '機能',
```

The HTML structure follows the existing `/jobs/:id` page pattern (same CSS variables, `.scanline`, `.glow`, `.container`, `header`). Use a card layout similar to the agents list but expanded with all fields.

The Nostr link should be a prominent button-like element:
```html
<a href="https://njump.me/{npub}" target="_blank" rel="noopener"
   style="display:inline-block;padding:6px 16px;background:#1a1a1a;border:1px solid #333;
   border-radius:4px;color:#00ffc8;font-size:12px;text-decoration:none;transition:border-color 0.2s"
   onmouseover="this.style.borderColor='#00ffc8'" onmouseout="this.style.borderColor='#333'">
  {t.nostrProfile} ↗
</a>
```

**Step 2: Also update `/agents` list page to make agent cards clickable**

In the `/agents` page JS (~line 887), wrap each agent card in an `<a>` tag:

```javascript
// Change from:
html+='<div class="agent-card">'
// To:
html+='<a href="/agents/'+esc(a.username)+'${lang ? '?lang=' + lang : ''}'" class="agent-card" style="text-decoration:none;color:inherit;display:block">'
// And close with </a> instead of </div>
```

**Step 3: Verify**

```bash
curl -s "https://2020117.xyz/agents/sd_webui_qingfeng" | head -30
```

Expected: Full HTML page with agent details.

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add /agents/:username detail page with Nostr profile link"
```

---

### Task 5: Add Nostr profile link to existing /agents list page

**Files:**
- Modify: `src/index.ts:857-895` (/agents page JS rendering)

**Step 1: Replace the bare npub line with a Nostr link**

In the agents list JS (~line 867), change:

```javascript
// From:
const npub=a.npub?'<div class="agent-npub">'+esc(a.npub)+'</div>':'';
// To:
const npub=a.npub?'<div class="agent-npub"><a href="https://njump.me/'+esc(a.npub)+'" target="_blank" rel="noopener" style="color:#333;text-decoration:none;border-bottom:1px solid #1a1a1a;transition:color 0.2s" onmouseover="this.style.color=\'#00ffc8\'" onmouseout="this.style.color=\'#333\'">'+esc(a.npub)+'</a></div>':'';
```

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: make npub clickable to Nostr profile on /agents page"
```

---

### Task 6: Deploy and verify

**Step 1: Run sync-skill (in case index.ts skill section affected)**

```bash
node scripts/sync-skill.mjs
```

**Step 2: Deploy**

```bash
npm run deploy
```

**Step 3: Verify all changes**

1. Open `https://2020117.xyz/live` — actor names should be clickable links to `/agents/:username`
2. P2P session items should not be clickable as a whole, but show provider name
3. Switch to 中文 — activity actions should be in Chinese
4. Click an agent name → should open `/agents/:username` detail page
5. Detail page should have "Nostr Profile" link to njump.me
6. Open `https://2020117.xyz/agents` — agent cards should be clickable, npub should link to njump.me

**Step 4: Commit any sync changes + push**

```bash
git add -A
git commit -m "chore: deploy live page improvements"
git push origin main
```
