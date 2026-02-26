# Agent Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let DVM providers publish structured capability descriptions (skill) so customers can discover and use their full features via both platform API and P2P.

**Architecture:** Skill is a JSON blob stored alongside each DVM service. It flows through three paths: platform API (discovery + filtering), P2P wire protocol (skill_request/skill_response), and Processor interface (JobRequest with params). No backward compatibility needed.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, D1 SQLite, Hyperswarm, Cashu

---

### Task 1: Processor Interface — JobRequest type + adapter updates

**Files:**
- Modify: `worker/src/processor.ts`
- Modify: `worker/src/adapters/ollama-processor.ts`
- Modify: `worker/src/adapters/http-processor.ts`
- Modify: `worker/src/adapters/exec-processor.ts`
- Modify: `worker/src/adapters/none-processor.ts`

**Step 1: Update processor.ts — add JobRequest, change Processor interface**

```typescript
// worker/src/processor.ts — full file replacement

export interface JobRequest {
  input: string
  params?: Record<string, unknown>
}

export interface Processor {
  readonly name: string
  verify(): Promise<void>
  generate(req: JobRequest): Promise<string>
  generateStream(req: JobRequest): AsyncGenerator<string>
}

export async function createProcessor(): Promise<Processor> {
  const spec = process.env.PROCESSOR || 'ollama'

  if (spec === 'none') {
    const { NoneProcessor } = await import('./adapters/none-processor.js')
    return new NoneProcessor()
  }

  if (spec === 'ollama') {
    const { OllamaProcessor } = await import('./adapters/ollama-processor.js')
    return new OllamaProcessor()
  }

  if (spec.startsWith('exec:')) {
    const cmd = spec.slice('exec:'.length)
    const { ExecProcessor } = await import('./adapters/exec-processor.js')
    return new ExecProcessor(cmd)
  }

  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    const { HttpProcessor } = await import('./adapters/http-processor.js')
    return new HttpProcessor(spec)
  }

  throw new Error(`Unknown PROCESSOR value: "${spec}". Use: none | ollama | exec:<cmd> | http(s)://<url>`)
}
```

**Step 2: Update OllamaProcessor — ignore params, use req.input**

In `worker/src/adapters/ollama-processor.ts`, change:
- `generate(prompt: string)` → `generate(req: JobRequest)`
- `generateStream(prompt: string)` → `generateStream(req: JobRequest)`
- Replace `prompt` with `req.input` inside both methods
- Add `import type { JobRequest } from '../processor.js'` (already imports Processor)

```typescript
import type { Processor, JobRequest } from '../processor.js'

// ...

  async generate(req: JobRequest): Promise<string> {
    return generate({ model: this.model, prompt: req.input })
  }

  async *generateStream(req: JobRequest): AsyncGenerator<string> {
    yield* generateStream({ model: this.model, prompt: req.input })
  }
```

**Step 3: Update HttpProcessor — POST { input, params } to backend**

In `worker/src/adapters/http-processor.ts`, change both methods to take `req: JobRequest`. Send `{ input: req.input, ...req.params }` as body so backend gets a flat object.

```typescript
import type { Processor, JobRequest } from '../processor.js'

// ...

  async generate(req: JobRequest): Promise<string> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: req.input, ...req.params }),
    })
    // ... rest unchanged
  }

  async *generateStream(req: JobRequest): AsyncGenerator<string> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson',
      },
      body: JSON.stringify({ input: req.input, ...req.params }),
    })
    // ... rest unchanged
  }
```

**Step 4: Update ExecProcessor — input on stdin, params as JOB_PARAMS env**

In `worker/src/adapters/exec-processor.ts`, change both methods. Pass `req.params` via `JOB_PARAMS` environment variable.

```typescript
import type { Processor, JobRequest } from '../processor.js'

// ...

  generate(req: JobRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env }
      if (req.params) env.JOB_PARAMS = JSON.stringify(req.params)
      const child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env })
      // ... rest unchanged, replace `prompt` with `req.input`
      child.stdin.write(req.input)
      child.stdin.end()
    })
  }

  async *generateStream(req: JobRequest): AsyncGenerator<string> {
    const env = { ...process.env }
    if (req.params) env.JOB_PARAMS = JSON.stringify(req.params)
    const child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    child.stdin.write(req.input)
    child.stdin.end()
    // ... rest unchanged
  }
```

**Step 5: Update NoneProcessor — use req.input**

```typescript
import type { Processor, JobRequest } from '../processor.js'

// ...

  async generate(req: JobRequest): Promise<string> {
    return req.input
  }

  async *generateStream(req: JobRequest): AsyncGenerator<string> {
    yield req.input
  }
```

**Step 6: Typecheck worker**

Run: `cd worker && npx tsc --noEmit`
Expected: Errors in agent.ts/provider.ts (callers still pass string). Fix in next tasks.

**Step 7: Commit**

```
feat(worker): change Processor interface from string to JobRequest
```

---

### Task 2: Update agent.ts and provider.ts callers to use JobRequest

**Files:**
- Modify: `worker/src/agent.ts` (all `processor.generate()` and `processor.generateStream()` calls)
- Modify: `worker/src/provider.ts` (same)

**Step 1: Fix agent.ts — wrap all processor calls**

Search for all `state.processor!.generate(` and `state.processor!.generateStream(` calls. Change:

- Line ~236: `state.processor!.generate(subResult)` → `state.processor!.generate({ input: subResult })`
- Line ~246: `state.processor!.generate(input)` → `state.processor!.generate({ input })`
- Line ~250: `state.processor!.generate(input)` → `state.processor!.generate({ input })`
- Line ~445: `state.processor!.generateStream(text)` → `state.processor!.generateStream({ input: text })`
- Line ~657: `state.processor!.generateStream(msg.input || '')` → `state.processor!.generateStream({ input: msg.input || '', params: msg.params })`

Note: the P2P handler at line ~657 now passes `msg.params` through to the processor. The async job handler (`processAsyncJob`) will also pass params from the inbox job — add `params` parameter to `processAsyncJob`.

In `processAsyncJob`, change signature to accept params:

```typescript
async function processAsyncJob(label: string, inboxJobId: string, input: string, params?: Record<string, unknown>) {
```

And in the direct-processing path (no pipeline):
```typescript
result = await state.processor!.generate({ input, params })
```

In the inbox poll loop, pass params:
```typescript
processAsyncJob(label, job.id, job.input, job.params ? JSON.parse(job.params) : undefined)
```

Wait — inbox jobs return `params` as a JSON string from the API. Check: the API endpoint `GET /api/dvm/inbox` already returns `params: j.params ? JSON.parse(j.params) : null`. So the `InboxJob` interface in `worker/src/api.ts` has `params?: Record<string, unknown>`. The agent poll loop accesses `job.params` directly (already parsed by the API response). So just pass it:

```typescript
processAsyncJob(label, job.id, job.input, job.params)
```

**Step 2: Fix provider.ts — pass params to generateStream**

In `runGeneration()` function (~line 203):
```typescript
for await (const chunk of generateStream({ model: MODEL, prompt: msg.input || '' })) {
```
Change to:
```typescript
for await (const chunk of generateStream({ model: MODEL, prompt: msg.input || '' })) {
```
Wait — provider.ts uses `generateStream` from `./adapters/ollama.js` directly, not via Processor interface. This is the standalone provider, not the unified agent. It doesn't use the Processor abstraction.

For provider.ts, just leave the Ollama call as-is (it calls the raw ollama adapter, not the Processor interface). The `msg.params` will be available but unused in the standalone provider. The unified agent (agent.ts) is the one that matters.

**Step 3: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS (or errors only in customer.ts which we fix next)

**Step 4: Commit**

```
feat(worker): pass JobRequest through agent processing pipeline
```

---

### Task 3: Wire Protocol — SwarmMessage + skill_request/skill_response

**Files:**
- Modify: `worker/src/swarm.ts`

**Step 1: Extend SwarmMessage interface**

Add to the `type` union: `'skill_request' | 'skill_response'`
Add fields: `params?: Record<string, unknown>` and `skill?: Record<string, unknown>`

```typescript
export interface SwarmMessage {
  type: 'skill_request' | 'skill_response' | 'request' | 'accepted' | 'chunk' | 'result' | 'error' | 'payment' | 'payment_ack' | 'offer' | 'pay_required' | 'stop'
  id: string
  kind?: number
  input?: string
  output?: string
  data?: string
  token?: string
  amount?: number
  message?: string
  params?: Record<string, unknown>     // request: structured job parameters
  skill?: Record<string, unknown>      // skill_response: full skill JSON
  // Streaming payment fields
  sats_per_chunk?: number
  chunks_per_payment?: number
  budget?: number
  earned?: number
  next?: number
  total_sats?: number
}
```

**Step 2: Update file header comment to document new message types**

Add to the wire protocol comment at top of file:
```
 *   → { type: "skill_request", id, kind }                   customer asks for skill
 *   ← { type: "skill_response", id, skill }                 provider returns skill JSON
```

**Step 3: Commit**

```
feat(worker): extend wire protocol with skill_request/response and params
```

---

### Task 4: Agent CLI — load skill file, handle skill_request on P2P

**Files:**
- Modify: `worker/src/agent.ts`

**Step 1: Add --skill CLI arg and skill loading**

In the CLI arg parser (top of file), add:
```typescript
case '--skill':        process.env.SKILL_FILE = val; break
```

Add a `loadSkill()` function after the config section:

```typescript
import { readFileSync } from 'fs'

function loadSkill(): Record<string, unknown> | null {
  const skillPath = process.env.SKILL_FILE
  if (!skillPath) return null
  try {
    const raw = readFileSync(skillPath, 'utf-8')
    const skill = JSON.parse(raw)
    if (!skill.name || !skill.version || !Array.isArray(skill.features)) {
      console.error(`[agent] Skill file missing required fields: name, version, features`)
      process.exit(1)
    }
    return skill
  } catch (e: any) {
    console.error(`[agent] Failed to load skill file "${skillPath}": ${e.message}`)
    process.exit(1)
  }
}
```

Add to AgentState:
```typescript
interface AgentState {
  // ... existing fields
  skill: Record<string, unknown> | null
}

const state: AgentState = {
  // ... existing fields
  skill: loadSkill(),
}
```

**Step 2: Pass skill to registerService**

In `setupPlatform()`:
```typescript
await registerService({
  kind: KIND,
  satsPerChunk: SATS_PER_CHUNK,
  chunksPerPayment: CHUNKS_PER_PAYMENT,
  model: state.processor?.name || 'unknown',
  models,
  skill: state.skill,
})
```

**Step 3: Handle skill_request in P2P listener**

In `startSwarmListener()`, in the `node.on('message', ...)` handler, add before the `if (msg.type === 'request')` block:

```typescript
if (msg.type === 'skill_request') {
  node.send(socket, {
    type: 'skill_response',
    id: msg.id,
    skill: state.skill,
  })
  return
}
```

**Step 4: Pass params from P2P request to generation**

In the P2P request handler (`msg.type === 'request'`), the `msg.params` is already available. In `runP2PGeneration()`, change the source selection:

```typescript
const source = SUB_KIND
  ? pipelineStream(SUB_KIND, msg.input || '', SUB_BUDGET)
  : state.processor!.generateStream({ input: msg.input || '', params: msg.params })
```

**Step 5: Log skill at startup**

In `main()`, after processor verify:
```typescript
if (state.skill) {
  console.log(`[${label}] Skill: ${state.skill.name} v${state.skill.version} (${(state.skill.features as string[]).join(', ')})`)
}
```

**Step 6: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS (or error in api.ts registerService — fix in task 5)

**Step 7: Commit**

```
feat(worker): load skill file and handle skill_request on P2P
```

---

### Task 5: Worker API client — registerService accepts skill

**Files:**
- Modify: `worker/src/api.ts`

**Step 1: Add skill to registerService options and body**

In `registerService()` function, add `skill` to the opts type:

```typescript
export async function registerService(opts: {
  kind: number
  satsPerChunk: number
  chunksPerPayment: number
  model?: string
  models?: string[]
  skill?: Record<string, unknown> | null
}): Promise<unknown | null> {
```

In the body construction, add:
```typescript
if (opts.skill) body.skill = opts.skill
```

**Step 2: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```
feat(worker): send skill in service registration API call
```

---

### Task 6: Customer — skill_request before request

**Files:**
- Modify: `worker/src/customer.ts`

**Step 1: Add skill_request/skill_response to customer flow**

After connecting to provider and before sending the request, send a `skill_request` and wait for `skill_response`:

In `main()`, after `console.log('[customer] Connected to provider...')`, add:

```typescript
// Query provider skill
console.log(`[customer] Querying provider skill...`)
const skillJobId = randomBytes(4).toString('hex')
node.send(peer.socket, { type: 'skill_request', id: skillJobId, kind: KIND })

const providerSkill = await new Promise<Record<string, unknown> | null>((resolve) => {
  const timer = setTimeout(() => {
    console.log(`[customer] No skill response (provider may not support skill)`)
    resolve(null)
  }, 5000)

  const handler = (msg: SwarmMessage) => {
    if (msg.type === 'skill_response' && msg.id === skillJobId) {
      clearTimeout(timer)
      node.removeListener('message', handler)
      resolve(msg.skill || null)
    }
  }
  node.on('message', handler)
})

if (providerSkill) {
  console.log(`[customer] Provider skill: ${providerSkill.name} v${providerSkill.version}`)
  if (providerSkill.features) {
    console.log(`[customer] Features: ${(providerSkill.features as string[]).join(', ')}`)
  }
}
```

Add `import { randomBytes } from 'crypto'` at top (already imported in agent.ts but not in customer.ts).

**Step 2: Log skill info but don't auto-construct params (customer is manual CLI)**

The standalone customer CLI is a simple prompt tool — it doesn't auto-construct params from skill. It just logs what the provider supports. Automated param construction happens when an agent acts as customer (in agent.ts delegateP2PStream).

**Step 3: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```
feat(worker): customer queries provider skill before sending request
```

---

### Task 7: Platform DB — add skill column

**Files:**
- Modify: `src/db/schema.ts`

**Step 1: Add skill column to dvmServices**

After the `models` line:
```typescript
skill: text('skill'),  // JSON: full skill descriptor
```

**Step 2: Generate and run migration**

```bash
# Generate migration
npx drizzle-kit generate

# Run on remote D1
npx wrangler d1 execute 2020117 --remote --command="ALTER TABLE dvm_service ADD COLUMN skill TEXT;"
```

**Step 3: Commit**

```
feat(db): add skill column to dvm_service table
```

---

### Task 8: Platform API — skill in service registration + new endpoints

**Files:**
- Modify: `src/routes/api.ts`

**Step 1: Accept skill in POST /api/dvm/services**

In the body type (~line 2846), add:
```typescript
skill?: Record<string, unknown>
```

In the update path, add:
```typescript
if (body.skill) updateSet.skill = JSON.stringify(body.skill)
```

In the insert path, add:
```typescript
skill: body.skill ? JSON.stringify(body.skill) : null,
```

**Step 2: Accept params in POST /api/dvm/request**

The body type already has `params?: Record<string, string>`. Change to `params?: Record<string, unknown>` (values can be objects, not just strings).

In the `extraParams` merge section (~line 2168), the current code already merges `body.params` into `extraParams` and stores it. Verify that the stored `params` JSON in `dvmJobs` includes the full structured params.

Check the existing line:
```typescript
const extraParams = { ...body.params }
```
This already spreads body.params. The params are stored as JSON in the job. This should work as-is for structured params.

**Step 3: Add GET /api/agents/:identifier/skill endpoint**

Add after the existing `GET /api/users/:identifier/activity` endpoint:

```typescript
api.get('/agents/:identifier/skill', async (c) => {
  const db = c.get('db')
  const identifier = c.req.param('identifier')

  // Resolve user by username, hex pubkey, or npub
  let userCondition
  if (identifier.startsWith('npub1')) {
    const pubkey = npubToPubkey(identifier)
    if (!pubkey) return c.json({ error: 'Invalid npub' }, 400)
    userCondition = eq(users.nostrPubkey, pubkey)
  } else if (/^[0-9a-f]{64}$/i.test(identifier)) {
    userCondition = eq(users.nostrPubkey, identifier.toLowerCase())
  } else {
    userCondition = eq(users.username, identifier)
  }

  const result = await db.select({
    username: users.username,
    skill: dvmServices.skill,
    kinds: dvmServices.kinds,
    models: dvmServices.models,
  })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(and(userCondition, eq(dvmServices.active, 1)))
    .limit(1)

  if (result.length === 0) return c.json({ error: 'Agent not found or no active service' }, 404)

  const row = result[0]
  return c.json({
    username: row.username,
    kinds: JSON.parse(row.kinds),
    models: row.models ? JSON.parse(row.models) : [],
    skill: row.skill ? JSON.parse(row.skill) : null,
  })
})
```

**Step 4: Add GET /api/dvm/skills endpoint**

```typescript
api.get('/dvm/skills', async (c) => {
  const db = c.get('db')
  const kindFilter = c.req.query('kind')

  const conditions = [eq(dvmServices.active, 1), sql`${dvmServices.skill} IS NOT NULL`]
  if (kindFilter) {
    // Filter services whose kinds JSON array contains the requested kind
    conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${dvmServices.kinds}) WHERE json_each.value = ${parseInt(kindFilter)})`)
  }

  const rows = await db.select({
    username: users.username,
    kinds: dvmServices.kinds,
    models: dvmServices.models,
    skill: dvmServices.skill,
  })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(and(...conditions))

  return c.json({
    skills: rows.map(r => ({
      username: r.username,
      kinds: JSON.parse(r.kinds),
      models: r.models ? JSON.parse(r.models) : [],
      skill: JSON.parse(r.skill!),
    })),
  })
})
```

**Step 5: Add ?feature= filter to GET /api/agents/online**

In the existing `/agents/online` handler, after fetching rows, add filtering:

```typescript
const featureFilter = c.req.query('feature')

// ... existing query ...

let filteredRows = rows
if (featureFilter) {
  filteredRows = rows.filter(r => {
    if (!r.skill) return false
    try {
      const skill = JSON.parse(r.skill)
      return Array.isArray(skill.features) && skill.features.includes(featureFilter)
    } catch { return false }
  })
}
```

This requires adding `skill: dvmServices.skill` to the select in the online agents query (alongside the existing leftJoin on dvmServices).

**Step 6: Typecheck platform**

Run: `npx tsc --noEmit` (from project root — uses wrangler types)

**Step 7: Commit**

```
feat(api): skill storage, query endpoints, and feature filtering
```

---

### Task 9: Cache — features and skill_name in agent list

**Files:**
- Modify: `src/services/cache.ts`

**Step 1: Add skill to the query select**

In `refreshAgentsCache()`, add to the localRows select:
```typescript
skill: dvmServices.skill,
```

**Step 2: Extract features and skill_name in the map**

In the `localAgents` map, add:
```typescript
features: row.skill ? (JSON.parse(row.skill).features || []) : [],
skill_name: row.skill ? (JSON.parse(row.skill).name || null) : null,
```

For external agents:
```typescript
features: [],
skill_name: null,
```

**Step 3: Add ?feature= filtering to GET /api/agents**

In `src/routes/api.ts`, the `GET /api/agents` endpoint reads from KV cache. Add post-fetch filtering:

```typescript
const featureFilter = c.req.query('feature')
if (featureFilter && agents) {
  agents = agents.filter((a: any) =>
    Array.isArray(a.features) && a.features.includes(featureFilter)
  )
}
```

**Step 4: Commit**

```
feat(cache): include features and skill_name in agent cache
```

---

### Task 10: Nostr — skill in Kind 31990 handler info

**Files:**
- Modify: `src/services/dvm.ts`

**Step 1: Add skill to buildHandlerInfoEvents params**

In the `buildHandlerInfoEvents` function, add `skill?: Record<string, unknown>` to the params type.

In the content JSON:
```typescript
...(params.skill ? { skill: params.skill } : {}),
```

**Step 2: Pass skill from service registration**

In `src/routes/api.ts`, in the `POST /api/dvm/services` handler where `buildHandlerInfoEvents` is called, add:
```typescript
skill: body.skill,
```

**Step 3: Commit**

```
feat(nostr): include skill in Kind 31990 handler info events
```

---

### Task 11: Documentation updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `worker/README.md`
- Modify: `skills/nostr-dvm/references/dvm-guide.md`
- Modify: `skills/nostr-dvm/references/streaming-guide.md`

**Step 1: CLAUDE.md — add --skill to CLI params table**

Add row:
```
| `--skill` | `SKILL_FILE` | Skill 描述文件路径（JSON） |
```

**Step 2: worker/README.md — add --skill to params table and add Skill section**

Add to CLI Parameters table:
```
| `--skill` | `SKILL_FILE` | Path to skill JSON file describing agent capabilities |
```

**Step 3: dvm-guide.md — add skill to service registration example**

Update the register example to show skill field.

**Step 4: streaming-guide.md — add SKILL_FILE to env vars table**

Add row in Agent Runtime table:
```
| `SKILL_FILE` | (none) | Path to skill JSON file |
```

**Step 5: Run sync-skill**

```bash
npm run sync-skill
```

**Step 6: Commit**

```
docs: document skill feature across all docs
```

---

### Task 12: Deploy and verify

**Step 1: Typecheck everything**

```bash
cd worker && npx tsc --noEmit
cd .. && npx tsc --noEmit  # or wrangler type check
```

**Step 2: Deploy platform**

```bash
npm run deploy
```

**Step 3: Build and publish worker**

```bash
cd worker
# bump version in package.json to 0.1.3
npm run build && npm publish
```

**Step 4: Verify API endpoints**

```bash
# Test skill endpoint (should return null for agents without skill)
curl https://2020117.xyz/api/agents/ollama_analyst/skill | jq .

# Test skills listing
curl https://2020117.xyz/api/dvm/skills?kind=5100 | jq .

# Test feature filtering
curl 'https://2020117.xyz/api/agents?feature=controlnet' | jq '.agents | length'
```

**Step 5: Commit version bump**

```
chore: bump worker to 0.1.3 with skill support
```
