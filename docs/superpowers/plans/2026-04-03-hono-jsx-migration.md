# Hono JSX Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate server-side HTML string generation to Hono JSX components, fixing avatar consistency and eliminating repeated structural code.

**Architecture:** Convert `shared-styles.ts` into JSX components (`PageLayout`, `Avatar`, nav icons). Rename page files `.ts` → `.tsx`. Client-side `<script>` content stays as template strings — JSX only covers what the server renders. Create `src/components/` for shared primitives.

**Tech Stack:** Hono 4.11.7 (built-in `hono/jsx`), TypeScript, Cloudflare Workers. No new dependencies.

**Scope boundary:** This plan converts server-side rendering to JSX. Client-side logic inside `<script>` tags is **not** changed — that remains as string templates and is a separate concern.

---

## File Map

**Create:**
- `src/components/Avatar.tsx` — `<Avatar seed pubkey? url? size?>` with correct pubkey-first seed logic
- `src/components/Layout.tsx` — `<PageLayout>`, `<Sidebar>`, `<BottomNav>`, `<FeedHeader>`
- `src/components/index.ts` — re-exports

**Modify:**
- `tsconfig.json` — add `"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"`
- `src/pages/shared-styles.ts` → keep CSS/JS string constants only; remove HTML-generating functions
- `src/pages/agents.ts` → `agents.tsx`
- `src/pages/landing.ts` → `landing.tsx`
- `src/pages/jobs.ts` → `jobs.tsx`
- `src/pages/market.ts` → `market.tsx`
- `src/pages/stats.ts` → `stats.tsx`
- `src/pages/chat.ts` → `chat.tsx`
- `src/pages/me.ts` → `me.tsx`
- `src/pages/notes.ts` → `notes.tsx`
- `src/pages/relay.ts` → `relay.tsx`
- `src/index.ts` → update imports

---

## Task 1: Enable Hono JSX in TypeScript

**Files:**
- Modify: `tsconfig.json`

- [ ] **Step 1: Add JSX config to tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  }
}
```

- [ ] **Step 2: Verify build still works**

```bash
npm run deploy -- --dry-run
# or just:
npx wrangler deploy --dry-run
```

Expected: no TypeScript errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "build: enable hono/jsx for JSX support"
```

---

## Task 2: Avatar Component

**Files:**
- Create: `src/components/Avatar.tsx`
- Modify: `src/lib/avatar.ts` (no change needed, just consumed)

**Context:** `beamDataUri(seed, sizePx)` is the server-side function in `src/lib/avatar.ts`. The canonical seed rule is **pubkey first**, then username/name fallback.

- [ ] **Step 1: Create `src/components/Avatar.tsx`**

```tsx
import { beamDataUri } from '../lib/avatar'

interface AvatarProps {
  pubkey?: string        // Nostr pubkey hex — primary seed
  username?: string      // fallback seed
  url?: string           // explicit URL (profile picture) — highest priority
  size?: number          // px, default 40
  class?: string
  alt?: string
}

export function Avatar({ pubkey, username, url, size = 40, class: cls, alt }: AvatarProps) {
  const seed = pubkey || username || 'unknown'
  const src = url || beamDataUri(seed, size)
  return (
    <img
      src={src}
      width={size}
      height={size}
      class={cls ?? 'avatar'}
      alt={alt ?? ''}
      loading="lazy"
    />
  )
}
```

- [ ] **Step 2: Create `src/components/index.ts`**

```ts
export { Avatar } from './Avatar'
export { PageLayout } from './Layout'
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/
git commit -m "feat: add Avatar JSX component with pubkey-first seed"
```

---

## Task 3: PageLayout Component

**Files:**
- Create: `src/components/Layout.tsx`
- Reference: `src/pages/shared-styles.ts` — copy icon SVGs, CSS constants, `connectWidget`, `headMeta`

**Context:** The current `pageLayout()` function in `shared-styles.ts` returns a full HTML document string. We replace it with a JSX component. CSS/JS string constants stay in `shared-styles.ts` unchanged.

- [ ] **Step 1: Create `src/components/Layout.tsx`**

```tsx
import { raw } from 'hono/html'
import { headMeta, BASE_CSS, LAYOUT_CSS, connectWidget } from '../pages/shared-styles'
import { IC_HOME, IC_AGENTS, IC_MARKET, IC_STATS, IC_DOC, IC_CHAT, IC_ME } from '../pages/shared-styles'

export interface PageLayoutProps {
  title: string
  description?: string
  baseUrl: string
  currentPath: string
  lang?: string
  pageCSS?: string
  headExtra?: string
  feedHeader?: string
  noPadding?: boolean
  rightSidebar?: string        // undefined = default connectWidget, '' = empty
  scripts?: string
  wideCenter?: boolean
  children?: any
}

function isActive(currentPath: string, path: string): string {
  if (path === '/') return currentPath === '/' ? ' active' : ''
  return currentPath.startsWith(path) ? ' active' : ''
}

export function PageLayout({
  title, description, baseUrl, currentPath, lang,
  pageCSS, headExtra, feedHeader, noPadding,
  rightSidebar, scripts, wideCenter, children,
}: PageLayoutProps) {
  const qs = lang ? `?lang=${lang}` : ''
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  const canonicalUrl = `${baseUrl}${currentPath.split('?')[0]}`
  const basePath = currentPath.split('?')[0]
  const sidebar = rightSidebar !== undefined ? rightSidebar : connectWidget(baseUrl, lang)
  const homeLabel = lang === 'zh' ? '首页' : lang === 'ja' ? 'ホーム' : 'Home'
  const marketLabel = lang === 'zh' ? '市场' : lang === 'ja' ? 'マーケット' : 'Market'
  const statsLabel = lang === 'zh' ? '统计' : lang === 'ja' ? '統計' : 'Stats'

  const notChatScript = currentPath !== '/chat' ? `
<script>
(function(){
  var ch; try { ch = new BroadcastChannel('chat_notify') } catch(e) { return }
  ch.onmessage = function(e) {
    if (!e.data || e.data.type !== 'response') return
    var toast = document.createElement('a')
    toast.href = '/chat'
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--c-accent);color:#fff;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.3);max-width:320px;text-align:center;animation:fadeInUp 0.3s ease'
    toast.textContent = '💬 Agent replied — tap to view'
    document.body.appendChild(toast)
    setTimeout(function(){ toast.remove() }, 8000)
  }
})()
</script>` : ''

  return (
    <html lang={htmlLang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title}</title>
        {description && <meta name="description" content={description} />}
        <meta property="og:title" content={title} />
        {description && <meta property="og:description" content={description} />}
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonicalUrl} />
        <meta property="og:image" content={`${baseUrl}/logo-512.png?v=2`} />
        <meta name="twitter:card" content="summary" />
        <link rel="canonical" href={canonicalUrl} />
        {raw(headMeta(baseUrl) + (headExtra || ''))}
        <style dangerouslySetInnerHTML={{ __html: BASE_CSS + '\n' + LAYOUT_CSS + '\n' + (pageCSS || '') }} />
      </head>
      <body>
        <div class="layout">
          <aside class="sidebar-left" role="navigation" aria-label="Main">
            <div class="sidebar-logo"><a href={`/${qs}`}>2020117<span class="blink" style="color:var(--c-accent)">_</span></a></div>
            <a href={`/${qs}`} class={`nav-item${isActive(currentPath, '/')}`} dangerouslySetInnerHTML={{ __html: IC_HOME + '<span class="nav-label">' + homeLabel + '</span>' }} />
            <a href={`/agents${qs}`} class={`nav-item${isActive(currentPath, '/agents')}`} dangerouslySetInnerHTML={{ __html: IC_AGENTS + '<span class="nav-label">Agents</span>' }} />
            <a href={`/chat${qs}`} class={`nav-item${isActive(currentPath, '/chat')}`} dangerouslySetInnerHTML={{ __html: IC_CHAT + '<span class="nav-label">Chat</span>' }} />
            <a href="/me" class={`nav-item${isActive(currentPath, '/me')}`} dangerouslySetInnerHTML={{ __html: IC_ME + '<span class="nav-label">Me</span>' }} />
            <a href={`/dvm/market${qs}`} class={`nav-item${isActive(currentPath, '/dvm')}`} dangerouslySetInnerHTML={{ __html: IC_MARKET + '<span class="nav-label">' + marketLabel + '</span>' }} />
            <a href={`/stats${qs}`} class={`nav-item${isActive(currentPath, '/stats')}`} dangerouslySetInnerHTML={{ __html: IC_STATS + '<span class="nav-label">' + statsLabel + '</span>' }} />
            <a href="/skill.md" class="nav-item" target="_blank" rel="noopener" dangerouslySetInnerHTML={{ __html: IC_DOC + '<span class="nav-label">skill.md</span>' }} />
            <div id="online-count" class="sidebar-online"></div>
            <div class="sidebar-lang">
              <a href={basePath} class={!lang ? 'active' : ''}>EN</a>
              <a href={`${basePath}?lang=zh`} class={lang === 'zh' ? 'active' : ''}>中文</a>
              <a href={`${basePath}?lang=ja`} class={lang === 'ja' ? 'active' : ''}>日本語</a>
            </div>
          </aside>

          <main class={`feed-col${wideCenter ? ' wide' : ''}`} role="main">
            {feedHeader && <div class="feed-header" dangerouslySetInnerHTML={{ __html: feedHeader }} />}
            {noPadding
              ? <>{children}</>
              : <div class="page-content">{children}</div>
            }
          </main>

          <aside class="sidebar-right" role="complementary">
            {sidebar && <div dangerouslySetInnerHTML={{ __html: sidebar }} />}
          </aside>
        </div>

        <nav class="bottom-nav" aria-label="Mobile navigation">
          <a href={`/${qs}`} class={`bnav-item${isActive(currentPath, '/')}`} dangerouslySetInnerHTML={{ __html: IC_HOME + '<span>' + homeLabel + '</span>' }} />
          <a href={`/agents${qs}`} class={`bnav-item${isActive(currentPath, '/agents')}`} dangerouslySetInnerHTML={{ __html: IC_AGENTS + '<span>Agents</span>' }} />
          <a href={`/chat${qs}`} class={`bnav-item${isActive(currentPath, '/chat')}`} dangerouslySetInnerHTML={{ __html: IC_CHAT + '<span>Chat</span>' }} />
          <a href="/me" class={`bnav-item${isActive(currentPath, '/me')}`} dangerouslySetInnerHTML={{ __html: IC_ME + '<span>Me</span>' }} />
          <a href={`/dvm/market${qs}`} class={`bnav-item${isActive(currentPath, '/dvm')}`} dangerouslySetInnerHTML={{ __html: IC_MARKET + '<span>' + marketLabel + '</span>' }} />
          <a href={`/stats${qs}`} class={`bnav-item${isActive(currentPath, '/stats')}`} dangerouslySetInnerHTML={{ __html: IC_STATS + '<span>' + statsLabel + '</span>' }} />
          <a href="/skill.md" class="bnav-item" target="_blank" rel="noopener" dangerouslySetInnerHTML={{ __html: IC_DOC + '<span>skill.md</span>' }} />
        </nav>

        {scripts && <div dangerouslySetInnerHTML={{ __html: scripts }} />}
        {notChatScript && <div dangerouslySetInnerHTML={{ __html: notChatScript }} />}
      </body>
    </html>
  )
}
```

- [ ] **Step 2: Export from `src/components/index.ts`**

Add `export { PageLayout } from './Layout'`

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/components/
git commit -m "feat: add PageLayout JSX component"
```

---

## Task 4: Migrate Simple Pages (jobs, stats, notes, relay)

**Files:**
- `src/pages/jobs.ts` → `src/pages/jobs.tsx`
- `src/pages/stats.ts` → `src/pages/stats.tsx`
- `src/pages/notes.ts` → `src/pages/notes.tsx`
- `src/pages/relay.ts` → `src/pages/relay.tsx`

**Pattern for each page:**

```tsx
// Before (jobs.ts)
return c.html(pageLayout({
  title: '...',
  baseUrl,
  currentPath: '/jobs/' + id,
  lang,
  pageCSS,
  scripts,
}, contentHtml))

// After (jobs.tsx)
import { PageLayout } from '../components'

return c.html(
  <PageLayout title="..." baseUrl={baseUrl} currentPath={`/jobs/${id}`} lang={lang} pageCSS={pageCSS} scripts={scripts}>
    <div dangerouslySetInnerHTML={{ __html: contentHtml }} />
  </PageLayout>
)
```

**Important:** Content HTML strings (built by the route handlers) are passed via `dangerouslySetInnerHTML`. This is safe since it's server-generated, never user input. The full JSX-ification of content HTML is a separate, later step.

- [ ] **Step 1: Rename `jobs.ts` → `jobs.tsx`, update import and return**

Replace `pageLayout({...}, contentString)` call with `<PageLayout {...props}><div dangerouslySetInnerHTML={{ __html: contentString }} /></PageLayout>`. Remove `pageLayout` import.

- [ ] **Step 2: Rename `stats.ts` → `stats.tsx`, same pattern**

- [ ] **Step 3: Rename `notes.ts` → `notes.tsx`, same pattern**

- [ ] **Step 4: Rename `relay.ts` → `relay.tsx`**

  ⚠️ `relay.ts` does NOT use `pageLayout()` — it has one live page route (`/timeline-legacy`) that uses the old `headerNav`/`pageFooter` 2-column layout directly. The redirect routes (`/live`, `/relay`, `/timeline`) stay as-is. For `/timeline-legacy`: either (a) migrate it to `<PageLayout>` gaining the new 3-column layout, or (b) just rename the file `.tsx` and leave its HTML string generation unchanged. Recommended: option (a) since this is an internal legacy route, but call it out explicitly if the visual change matters.

- [ ] **Step 5: Update imports in `src/index.ts`**

Imports like `import jobsPage from './pages/jobs'` continue to work (Bundler resolution finds `.tsx`).

- [ ] **Step 6: Build and deploy**

```bash
npm run deploy
```

Expected: site works identically, no visual change.

- [ ] **Step 7: Commit**

```bash
git add src/pages/jobs.tsx src/pages/stats.tsx src/pages/notes.tsx src/pages/relay.tsx
git rm src/pages/jobs.ts src/pages/stats.ts src/pages/notes.ts src/pages/relay.ts
git commit -m "refactor: migrate jobs/stats/notes/relay pages to Hono JSX"
```

---

## Task 5: Migrate Content-Heavy Pages (landing, market, agents)

**Files:**
- `src/pages/landing.ts` → `landing.tsx`
- `src/pages/market.ts` → `market.tsx`
- `src/pages/agents.ts` → `agents.tsx`

Same pattern as Task 4 — use `<PageLayout>` and `dangerouslySetInnerHTML` for content that is still string-built.

Additionally, in `agents.tsx`, the server-side detail page (`/agents/:id`) renders an `<img>` for the avatar. Replace it with `<Avatar>`:

```tsx
// Before
const avatarUrl = u.avatarUrl || beamDataUri(u.nostrPubkey || username, 80)
// ...
<img class="agent-avatar" src="${esc(avatarUrl)}" ...>

// After
import { Avatar } from '../components'
// In JSX:
<Avatar url={u.avatarUrl} pubkey={u.nostrPubkey} size={80} class="agent-avatar" alt={displayName} />
```

- [ ] **Step 1: Rename `landing.ts` → `landing.tsx`, switch to `<PageLayout>`**
- [ ] **Step 2: Rename `market.ts` → `market.tsx`, switch to `<PageLayout>`**
- [ ] **Step 3: Rename `agents.ts` → `agents.tsx`, switch to `<PageLayout>` + `<Avatar>` on detail page**
- [ ] **Step 4: Build and deploy**

```bash
npm run deploy
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/landing.tsx src/pages/market.tsx src/pages/agents.tsx
git rm src/pages/landing.ts src/pages/market.ts src/pages/agents.ts
git commit -m "refactor: migrate landing/market/agents pages to Hono JSX"
```

---

## Task 6: Migrate chat and me Pages

**Files:**
- `src/pages/chat.ts` → `chat.tsx`
- `src/pages/me.ts` → `me.tsx`

These pages have heavy client-side scripts (Nostr, localStorage). The scripts stay as strings. Only the `pageLayout()` call changes to `<PageLayout>`.

- [ ] **Step 1: Rename `chat.ts` → `chat.tsx`, switch to `<PageLayout>`**

```tsx
return c.html(
  <PageLayout
    title="Chat — 2020117"
    description="Chat with AI agents on the Nostr network. No account needed."
    baseUrl={baseUrl}
    currentPath="/chat"
    lang={lang}
    feedHeader="Chat"
    pageCSS={pageCSS}
    scripts={scripts}
    noPadding={true}
    rightSidebar=""
    wideCenter={true}
  >
    <div dangerouslySetInnerHTML={{ __html: content }} />
  </PageLayout>
)
```

- [ ] **Step 2: Rename `me.ts` → `me.tsx`, switch to `<PageLayout>`**

- [ ] **Step 3: Build and deploy**

```bash
npm run deploy
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/chat.tsx src/pages/me.tsx
git rm src/pages/chat.ts src/pages/me.ts
git commit -m "refactor: migrate chat/me pages to Hono JSX"
```

---

## Task 7: Clean up shared-styles.ts

**Files:**
- Modify: `src/pages/shared-styles.ts`

Now that all pages use `<PageLayout>`, the `pageLayout()` function and `headerNav()` function in `shared-styles.ts` are dead code. Remove them. Keep:
- CSS string constants (`BASE_CSS`, `LAYOUT_CSS`, `FONT_LINKS`)
- JavaScript string constants (`NOTE_RENDER_JS`)
- Icon SVG constants (`IC_HOME`, `IC_AGENTS`, etc.)
- `headMeta()`, `connectWidget()`, `pageFooter()` helpers
- `PageLayoutOpts` type (now lives in `Layout.tsx`)

- [ ] **Step 1: Delete `pageLayout()` function from `shared-styles.ts`**
- [ ] **Step 2: Delete `headerNav()` function from `shared-styles.ts`**
- [ ] **Step 3: Delete `PageLayoutOpts` interface from `shared-styles.ts`** — it is superseded by `PageLayoutProps` in `Layout.tsx`. These are different names; nothing is "moved". Just delete the old one after confirming no remaining imports.
- [ ] **Step 4: Verify no remaining imports of `pageLayout` anywhere**

```bash
grep -r "pageLayout\|headerNav" src/
```

Expected: zero results.

- [ ] **Step 5: Build**

```bash
npx tsc --noEmit && npm run deploy
```

- [ ] **Step 6: Commit**

```bash
git add src/pages/shared-styles.ts
git commit -m "refactor: remove dead string-template functions from shared-styles"
```

---

## Verification

After all tasks, confirm:

- [ ] `npx tsc --noEmit` — zero TypeScript errors
- [ ] `npm run deploy` — deploys successfully
- [ ] Visual spot-check: `/`, `/agents`, `/agents/alice`, `/chat`, `/me`, `/dvm/market`
- [ ] Avatar on `/agents/alice` matches avatar on `/me` page
- [ ] Nav active state correct on each page
- [ ] Mobile bottom nav works
- [ ] No regression in i18n (add `?lang=zh` to any page)

---

## Notes for implementers

- **`dangerouslySetInnerHTML`** is necessary for injecting CSS strings (`<style>`) and existing content strings. This is safe — all content is server-generated.
- **SVG icon strings** cannot be used directly as JSX children (they're raw strings). Use `dangerouslySetInnerHTML` or convert each to a JSX component.
- **`<script>` injection**: Pass the scripts string via `PageLayout`'s `scripts` prop — it uses `dangerouslySetInnerHTML` internally.
- **`c.html()` with JSX**: Hono's `c.html()` accepts a `JSX.Element`. Use `c.html(<PageLayout>...</PageLayout>)` directly — no need to call `renderToString()` manually.
- **Do NOT convert client-side JS** inside `<script>` tags to JSX. That code runs in the browser and must remain as strings.
