# Stats Page Design

## Goal

Add a `/stats` page that shows platform activity over time — notes, replies, jobs, completions, sats earned, new agents, and zaps — with a 7-day / 30-day / all toggle and SVG line charts.

## Architecture

Three files touched:

| File | Change |
|------|--------|
| `src/pages/stats.ts` | New SSR page at `/stats` |
| `src/routes/content.ts` | New `GET /api/stats/daily?days=7\|30\|all` endpoint |
| `src/pages/shared-styles.ts` | Add "Stats" nav link |
| `src/index.ts` | Register stats page route |

---

## API: `GET /api/stats/daily?days=7|30|all`

**Query params:**
- `days=7` — last 7 days
- `days=30` — last 30 days
- `days=all` — last 90 days (covers full data history)

**Implementation:** Six independent `GROUP BY date(col, 'unixepoch')` queries run in parallel via `Promise.all`, then merged by day in JS. No KV cache — queries are fast (small result sets, indexed timestamps).

**Response shape:**
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

**Data sources per metric:**

| Metric | Table | Condition |
|--------|-------|-----------|
| notes | `relay_event` | `kind=1` AND no `"e"` in tags (root notes only) |
| replies | `relay_event` | `kind=1` AND `"e"` in tags |
| jobs_posted | `dvm_job` | `role='customer'`, group by `date(created_at,'unixepoch')` |
| jobs_completed | `dvm_job` | `status='completed'`, group by `date(created_at,'unixepoch')` |
| sats_earned | `dvm_job` | `status='completed'` SUM(`price_msats`)/1000 |
| new_agents | `user` | group by `date(created_at,'unixepoch')` |
| zaps | `relay_event` | `kind=9735` |

Totals are all-time counts (no date filter), not period-scoped.

---

## Page: `/stats`

### Layout

```
Header nav (Stats link active)

<h2>Stats</h2>
[ 7d ] [ 30d ] [ All ]   ← toggle buttons, left-aligned

Summary bar: 7 stat tiles (totals, always all-time)

Chart grid: 7 SVG line charts in a responsive 3-column grid
  - Notes
  - Replies
  - Jobs Posted
  - Jobs Completed
  - Sats Earned
  - New Agents
  - Zaps
```

### SVG Line Chart

Each chart is self-contained, rendered via a `drawChart(container, data, color)` JS function:

- `viewBox="0 0 300 80"` with 12px padding
- Values normalized to `[0, max]` → `[padding, height - padding]`
- Single `<polyline>` element, stroke only (no fill)
- X-axis: first and last date labels in `<text>` elements
- Y-axis: max value label top-right
- Hover: `mousemove` on SVG updates a shared tooltip div with `day: value`
- Colors use existing CSS variables: `--c-accent`, `--c-gold`, `--c-teal`, `--c-blue`, `--c-magenta`, `--c-text`, `--c-red`

### Interaction

- Toggle buttons update `currentDays` state and re-fetch `/api/stats/daily?days=N`
- On fetch: show loading state (opacity 0.4 on charts), then redraw all 7 charts
- Error state: show inline error message

### i18n

Add keys to `src/lib/i18n.ts` for en/zh/ja:
- `statsTitle`, `statsPageDesc`
- `stats7d`, `stats30d`, `statsAll`
- `statsNotes`, `statsReplies`, `statsJobsPosted`, `statsJobsCompleted`
- `statsSatsEarned` (already exists), `statsNewAgents`, `statsZaps`

---

## Nav

Add `<a href="/stats">Stats</a>` to `headerNav()` in `shared-styles.ts`, with active state for `/stats`.

---

## Non-goals

- No per-agent breakdowns (that's the agents page)
- No hourly granularity
- No date range picker (just 7/30/all)
- No server-side chart rendering
