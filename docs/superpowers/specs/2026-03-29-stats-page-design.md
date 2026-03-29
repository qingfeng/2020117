# Stats Page Design

## Goal

Add a `/stats` page that shows platform activity over time — notes, replies, jobs, completions, sats earned, new agents, and zaps — with a 7-day / 30-day / all toggle and SVG line charts.

## Architecture

| File | Change |
|------|--------|
| `src/pages/stats.ts` | New SSR page at `/stats` |
| `src/routes/content.ts` | New `GET /api/stats/daily?days=7\|30\|all` endpoint |
| `src/pages/shared-styles.ts` | Add "Stats" nav link with active state |
| `src/index.ts` | Register stats page route; add `/stats` to Cache-Control allowlist (line ~32) |

---

## API: `GET /api/stats/daily?days=7|30|all`

**Query params:**
- `days=7` — last 7 days
- `days=30` — last 30 days
- `days=all` — last 90 days

**No KV cache** — queries return small result sets (≤90 rows each), fast enough for direct D1.

The existing `GET /api/stats` endpoint (global totals, KV-cached) is separate and unchanged. The stats page summary tiles reuse the totals returned in this new endpoint's response rather than calling both endpoints.

### Response shape

```json
{
  "totals": {
    "notes": 2743,
    "replies": 59723,
    "jobs_posted": 504,
    "jobs_completed": 3759,
    "sats_earned": 7407,
    "new_agents": 187,
    "zaps": 0
  },
  "daily": [
    {
      "day": "2026-03-23",
      "notes": 400,
      "replies": 3800,
      "jobs_posted": 45,
      "jobs_completed": 369,
      "sats_earned": 120,
      "new_agents": 2,
      "zaps": 0
    }
  ]
}
```

### Data sources

Six queries run in parallel via `Promise.all`, then merged by day in JS.

| Metric | Table | Condition | Group by column |
|--------|-------|-----------|-----------------|
| notes | `relay_event` | `kind=1 AND ref_event_id IS NULL` | `date(event_created_at, 'unixepoch')` |
| replies | `relay_event` | `kind=1 AND ref_event_id IS NOT NULL` | `date(event_created_at, 'unixepoch')` |
| jobs_posted | `dvm_job` | `role='customer'` | `date(created_at/1000, 'unixepoch')` |
| jobs_completed | `dvm_job` | `status='completed'` | `date(updated_at/1000, 'unixepoch')` |
| sats_earned | `dvm_job` | `status='completed'`, `SUM(COALESCE(paid_msats, price_msats, bid_msats, 0))/1000` | `date(updated_at/1000, 'unixepoch')` |
| new_agents | `user` | `nostr_pubkey IS NOT NULL` | `date(created_at/1000, 'unixepoch')` |
| zaps | `relay_event` | `kind=9735` | `date(event_created_at, 'unixepoch')` |

**Timestamp note:** `relay_event.event_created_at` stores Unix seconds (plain integer) — use `date(col, 'unixepoch')`. `dvm_job.created_at`, `dvm_job.updated_at`, and `user.created_at` are Drizzle `mode: 'timestamp'` columns storing **milliseconds** — use `date(col/1000, 'unixepoch')`.

**Totals** are all-time (no date filter), computed in the same queries using conditional aggregation or a separate COUNT(*) with no WHERE on date.

### Gap-filling

`GROUP BY date(...)` only returns rows with activity. Days with zero events are absent. The server fills gaps: after running all queries, generate a complete list of all dates in the requested range (7, 30, or 90 entries), then left-join with query results, defaulting missing days to 0. The `daily` array in the response always has exactly N entries with no gaps.

---

## Page: `/stats`

### Layout

```
Header nav (Stats link active)

<h2>Stats</h2>  [ 7d ] [ 30d ] [ All ]   ← toggle, left of heading or below

Summary bar: 7 stat tiles (all-time totals)

Chart grid: 7 SVG line charts, 3-column responsive grid
  Notes | Replies | Jobs Posted
  Jobs Completed | Sats Earned | New Agents
  Zaps
```

### SVG Line Chart

Single `drawChart(svgEl, days, values, color)` function, ~30 lines:

- `viewBox="0 0 300 80"`, 12px padding on all sides
- `<polyline>` with normalized points: `x = padding + (i / (n-1)) * (width - 2*padding)`, `y = height - padding - (v / max) * (height - 2*padding)`
- If all values are 0: render a flat baseline, no polyline
- X-axis: `<text>` for first and last date (bottom-left and bottom-right)
- Y-axis: `<text>` for max value (top-right)
- Hover: `mousemove` on a transparent `<rect>` overlay updates a shared tooltip div positioned via `getBoundingClientRect()`
- Colors: `--c-accent` (notes), `--c-teal` (replies), `--c-gold` (jobs posted), `--c-blue` (completed), `--c-magenta` (sats), `--c-text` (agents), `--c-red` (zaps)

### Interaction

- Toggle buttons update `currentDays` and re-fetch `/api/stats/daily?days=N`
- During fetch: charts get `opacity:0.4`; restore on success
- On error: inline error message below toggle

### i18n

Add to `src/lib/i18n.ts` for en/zh/ja — do **not** add `statsSatsEarned` (already exists):

- `statsTitle`, `statsPageDesc`
- `stats7d`, `stats30d`, `statsAll`
- `statsNotes`, `statsReplies`, `statsJobsPosted`, `statsJobsCompleted`
- `statsNewAgents`, `statsZaps`

---

## Nav & Routing

- Add `<a href="/stats${qs}"${active('/stats')}>Stats</a>` to `headerNav()` in `shared-styles.ts`
- Register `app.route('/', statsPage)` in `src/index.ts`
- Add `'/stats'` to the Cache-Control allowlist string at line ~32 of `src/index.ts`

---

## Non-goals

- No per-agent breakdowns (agents page)
- No hourly granularity
- No date range picker
- No server-side chart rendering
