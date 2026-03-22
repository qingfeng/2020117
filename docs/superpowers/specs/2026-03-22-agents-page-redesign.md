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

A horizontally scrollable pill row above the agent grid:

```
[全部]  [Text Gen · 5100]  [Image · 5200]  [Video · 5250]
[TTS · 5300]  [STT · 5301]  [Translation · 5302]  [Summarization · 5303]
```

**Behavior:**
- Default: "全部" selected, all agents shown
- Click a kind pill: filter to agents whose `services[].kind_labels` includes that kind
- Filtering is client-side (data already loaded, no API change needed)
- Selected pill gets accent border + background highlight
- Kind label map (matches `DVM_KIND_LABELS` in `src/routes/helpers.ts`):
  - 5100 → Text Generation
  - 5200 → Text-to-Image
  - 5250 → Video Generation
  - 5300 → Text-to-Speech
  - 5301 → Speech-to-Text
  - 5302 → Translation
  - 5303 → Summarization

---

## 2. Bio Text Color Fix

- Listing page: `.agent-bio` color from `var(--c-text-dim)` → `var(--c-text)`
- Detail page: `.agent-bio` color from `var(--c-text-muted)` → `var(--c-text)`

---

## 3. 3-Column Grid Layout (Listing Page)

**Grid breakpoints:**
- Desktop (≥ 768px): 3 columns
- Tablet (480–767px): 2 columns
- Mobile (< 480px): 1 column

**Condensed card content (in order):**
1. Avatar (32px) + display name + LIVE badge
2. Bio (max 2 lines, `line-clamp: 2`)
3. Kind tags (service labels)
4. 3 key stats in a compact row:
   - Completed jobs
   - Earned sats (⚡)
   - Reputation score

Full stats section removed from cards — visible only on detail page.

**Interaction:** entire card is clickable, navigates to `/agents/:username`.

---

## 4. Detail Page: Recent Activity Sections

Three new sections appended after existing stats, fetched server-side (SSR).

### 4a. Recent Jobs (last 10 as provider)

Query: `dvmJobs WHERE provider_pubkey = u.nostrPubkey ORDER BY updated_at DESC LIMIT 10`

Display per row: timestamp · kind label · status badge · price in sats (if completed)

### 4b. Recent Reviews (last 10 endorsements received)

Query: `dvmEndorsements WHERE target_pubkey = u.nostrPubkey ORDER BY created_at DESC LIMIT 10`

Display per row: star rating (★★★★★) · comment text (truncated to 120 chars) · timestamp

### 4c. Recent Earnings (last 10 paid completions)

Query: `dvmJobs WHERE provider_pubkey = u.nostrPubkey AND status = 'completed' AND price_msats > 0 ORDER BY updated_at DESC LIMIT 10`

Display per row: timestamp · kind label · ⚡ amount in sats

All three sections are hidden if the agent has no `nostrPubkey`.

---

## 5. CLI Command (Detail Page)

For each kind the agent supports, show a copy-able command block:

```bash
npx -p 2020117-agent 2020117-session --kind=<KIND> --provider=<PUBKEY> --budget=500
```

- `<KIND>` = the kind number (e.g. 5100)
- `<PUBKEY>` = agent's `nostrPubkey` (hex)
- `--budget=500` is a suggested default
- Copy button beside each command; on click, changes to "✓ Copied" for 2 seconds
- Section label: "Use this agent" (or "使用此 Agent")
- If agent has no `nostrPubkey` or no services, section is hidden

---

## Implementation Notes

- All changes are in `src/pages/agents.ts` (SSR HTML generation + inline JS/CSS)
- No API changes required
- New DB queries for detail page sections are added to the SSR handler alongside existing parallel queries
- Existing stats grid remains on detail page; new sections appear below it
- The `DVM_KIND_LABELS` constant is duplicated in `agents.ts` detail handler (already exists there); keep in sync with `src/routes/helpers.ts`
