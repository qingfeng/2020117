# Agents Page Redesign

**Date:** 2026-03-22
**Scope:** `/agents` listing page + `/agents/:username` detail page
**Files:** `src/pages/agents.ts`

## Goals

1. Kind-based filter bar with human-readable labels
2. Lighter bio text color (was too dim)
3. 3-column grid layout with condensed cards
4. Detail page: recent jobs, reviews, and earnings sections
5. Detail page: copy-able CLI command to use the agent

---

## 1. Kind Filter Bar (Listing Page)

A horizontally scrollable pill row above the agent grid.

**Pills:**
```
[全部]  [text processing · 5100]  [text-to-image · 5200]  [video generation · 5250]
[text-to-speech · 5300]  [speech-to-text · 5301]  [translation · 5302]  [summarization · 5303]
```

Labels match `DVM_KIND_LABELS` in `src/routes/helpers.ts` exactly:
```
5100 → 'text processing'
5200 → 'text-to-image'
5250 → 'video generation'
5300 → 'text-to-speech'
5301 → 'speech-to-text'
5302 → 'translation'
5303 → 'summarization'
```

**DOM structure:** each pill gets a `data-kind` attribute with the kind number:
```html
<button class="kind-pill" data-kind="5100">text processing · 5100</button>
```
"全部" pill has `data-kind="0"` (treated as "no filter").

**JS filter predicate:**
```js
const selected = parseInt(pill.dataset.kind)
agents.filter(a => selected === 0 || a.services.some(s => s.kinds.includes(selected)))
```

Filtering is **client-side** (data already loaded from `/api/agents`, no API change needed).

**Behavior:** Selected pill gets accent border + background highlight. Default: "全部" selected.

---

## 2. Bio Text Color Fix

- Listing page: `.agent-bio` color from `var(--c-text-dim)` → `var(--c-text)`
  (`--c-text-dim` is `#586e75`, confirmed in `shared-styles.ts` line 19)
- Detail page: `.agent-bio` color from `var(--c-text-muted)` → `var(--c-text)`
  (`--c-text-muted` is `#666`, confirmed in `shared-styles.ts` line 20)

---

## 3. 3-Column Grid Layout (Listing Page)

**Grid breakpoints:**
- Desktop (≥ 768px): 3 columns — `grid-template-columns: repeat(3, 1fr)`
- Tablet (480–767px): 2 columns — `repeat(2, 1fr)`
- Mobile (< 480px): 1 column — `1fr`

Change `#agents` from `flex-direction:column` to `display:grid`.

**Condensed card content (in order):**
1. Avatar (32px) + display name + LIVE badge
2. Bio (max 2 lines, `overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical`)
3. Kind tags (service labels)
4. Compact stats row (class `.agent-stats-compact`): 3 items in a flex row:
   - Completed jobs
   - ⚡ Earned sats
   - Reputation score

**Remove from cards:** full stats grid (14 cells), npub row (including the `<a>` anchor with `event.stopPropagation()`) — these remain on the detail page only.

**Interaction:** entire card is clickable, navigates to `/agents/:username`.

---

## 4. Detail Page: Recent Activity Sections

Three new sections appended after the existing stats grid. All are SSR-fetched and conditional on `u.nostrPubkey` being set (return empty if null).

Add new queries to the existing `Promise.all` in the SSR handler.

### 4a. Recent Jobs (last 10 as provider)

```sql
SELECT kind, status, COALESCE(price_msats, bid_msats, 0) AS earned_msats, updated_at
FROM dvm_job
WHERE provider_pubkey = ?
ORDER BY updated_at DESC
LIMIT 10
```

Uses `COALESCE(price_msats, bid_msats, 0)` — consistent with existing earnings formula in the stats grid above.

Display per row: timestamp · kind label (via `DVM_KIND_LABELS`) · status badge · `Math.floor(earned_msats / 1000)` sats (only if > 0)

### 4b. Recent Reviews (last 10, from `dvmReviews` / `dvm_review`)

```sql
SELECT rating, content, job_kind, created_at
FROM dvm_review
WHERE target_pubkey = ?
ORDER BY created_at DESC
LIMIT 10
```

- `rating`: integer 1–5, non-null
- `content`: text, nullable — if null, omit text entirely (show stars + timestamp only)
- `job_kind`: integer — map through `DVM_KIND_LABELS` and display as kind label beside stars
- Display per row: ★ stars · kind label · content (truncated to 120 chars, omitted if null) · timestamp

### 4c. Recent Earnings (last 10 paid completions)

```sql
SELECT kind, COALESCE(price_msats, bid_msats, 0) AS earned_msats, updated_at
FROM dvm_job
WHERE provider_pubkey = ?
  AND status = 'completed'
  AND (price_msats > 0 OR bid_msats > 0)
ORDER BY updated_at DESC
LIMIT 10
```

Display per row: timestamp · kind label · ⚡ `Math.floor(earned_msats / 1000)` sats

---

## 5. CLI Command (Detail Page)

Section label: "Use this agent" (shown only if agent has `nostrPubkey` and at least one service kind).

Iterate `services[0].kinds` (a flat number array from the API) and render one command block per kind:

```bash
npx -p 2020117-agent 2020117-session --kind=<KIND> --provider=<PUBKEY> --budget=500
```

- `<KIND>` = kind number (e.g. `5100`)
- `<PUBKEY>` = `u.nostrPubkey` (hex)
- `--budget=500` is a verified real flag (maps to `BUDGET_SATS` in `session.ts` line 25)
- `--provider` flag exists and sets `PROVIDER_PEER` env var, but peer filtering may not be active in the current Hyperswarm implementation — show the flag anyway as it is part of the documented interface
- Copy button beside each command; on click: copy to clipboard, change button text to "✓ Copied" for 2 seconds

---

## Implementation Notes

- All changes in `src/pages/agents.ts` only — no API or schema changes
- New DB queries use Drizzle ORM with `sqlOp` for raw SQL expressions, wrapped in the existing `Promise.all`
- `DVM_KIND_LABELS` is already duplicated in `agents.ts` line 279 (detail handler); keep it in sync with `src/routes/helpers.ts` — both should use lowercase labels matching helpers.ts
- `--c-text-dim` and `--c-text-muted` are both defined in `BASE_CSS` from `shared-styles.ts`
