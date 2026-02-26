# Agent Skill — Capability Publishing & Discovery

## Problem

DVM Providers can only declare `kinds`, `description`, `models` when registering. Customers have no way to discover a provider's full capabilities (supported parameters, available resources, input/output formats). Agents can only send plain text prompts, wasting most of a capable provider's features.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Processor interface | Unified `JobRequest { input, params }` | HttpProcessor can forward entire request to backend (SD WebUI etc.) without translation |
| Skill definition | Local JSON file (`--skill=./skill.json`) | Skill describes local capabilities; most accurate at source; works in P2P-only mode |
| P2P discovery | `skill_request` / `skill_response` message pair | Customer needs skill before constructing params; lightweight, no payment involved |
| Output format | Unified string (images as base64) | Simple, no wire protocol changes for binary; optimize later if needed |
| Architecture | Skill as independent data layer | Skill is declarative metadata, doesn't drive routing; YAGNI on multi-capability routing |

## 1. Skill File Format

```json
{
  "name": "sd-webui-provider",
  "version": "1.0",
  "features": ["controlnet", "lora", "adetailer", "hires_fix", "img2img"],
  "input_schema": {
    "prompt": { "type": "string", "required": true },
    "negative_prompt": { "type": "string" },
    "model": { "type": "string", "enum_from": "resources.models" },
    "lora": { "type": "array", "items": { "name": "string", "weight": "number" } },
    "params": {
      "type": "object",
      "properties": {
        "width": { "type": "number", "min": 256, "max": 2048, "default": 512 },
        "height": { "type": "number", "min": 256, "max": 2048, "default": 768 },
        "steps": { "type": "number", "min": 1, "max": 150, "default": 28 },
        "cfg_scale": { "type": "number", "min": 1, "max": 30, "default": 7 },
        "sampler": { "type": "string", "enum_from": "resources.samplers" },
        "seed": { "type": "number", "default": -1 }
      }
    }
  },
  "output_schema": {
    "type": "string",
    "format": "base64-png"
  },
  "resources": {
    "models": ["majicmixRealistic_v7", "v1-5-pruned-emaonly"],
    "loras": ["extreme_smooth_black_pantyhose-ep7"],
    "controlnet_models": ["control_v11p_sd15_openpose"],
    "samplers": ["DPM++ 2M SDE", "Euler a", "DDIM"]
  }
}
```

Platform stores `skill` as JSON blob. Only `features` array is indexed for filtering.

## 2. JobRequest & Processor Interface

```typescript
interface JobRequest {
  input: string
  params?: Record<string, unknown>
}

interface Processor {
  readonly name: string
  verify(): Promise<void>
  generate(req: JobRequest): Promise<string>
  generateStream(req: JobRequest): AsyncGenerator<string>
}
```

Adapter behavior:

| Adapter | params handling |
|---------|---------------|
| OllamaProcessor | Ignores params, uses `req.input` |
| HttpProcessor | POSTs `{ input, params }` to backend URL |
| ExecProcessor | `req.input` on stdin, `JOB_PARAMS` env var |
| NoneProcessor | Returns `req.input` |

## 3. P2P Wire Protocol

New message types:

```
Customer                              Provider
   |                                     |
   |--- skill_request { kind }        -->|
   |<-- skill_response { skill }        |
   |                                     |
   |--- request { kind, input,        -->|
   |      params, budget }               |
   |<-- offer { ... }                   |
   |    ... (rest unchanged)             |
```

SwarmMessage additions:

```typescript
interface SwarmMessage {
  type: 'skill_request' | 'skill_response' | 'request' | 'offer' | ...
  id: string
  kind?: number
  input?: string
  params?: Record<string, unknown>    // NEW
  skill?: Record<string, unknown>     // NEW: carried by skill_response
  budget?: number
  // ... rest unchanged
}
```

- Provider: on `skill_request`, returns loaded skill.json (or `skill: null`)
- Customer: sends `skill_request` first, constructs params from skill, then sends `request`

## 4. Platform API

### DB

`dvm_service` table: add `skill TEXT` column (JSON blob).

### Service Registration

```
POST /api/dvm/services
{
  "kinds": [5200],
  "description": "...",
  "models": [...],
  "skill": { ... }
}
```

### New Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/agents/:identifier/skill | No | Full skill JSON for an agent |
| GET | /api/dvm/skills?kind=5200 | No | All registered skills for a kind |

### Enhanced Endpoints

| Endpoint | Change |
|----------|--------|
| GET /api/agents/online | Add `?feature=xxx` filter |
| GET /api/agents | Cache includes `features` array, supports `?feature=` |
| GET /api/dvm/inbox | Jobs include `params` field |
| POST /api/dvm/request | Accepts `params`, stores in job, passes to provider |

### Cache (cache.ts)

Agent cache gains:
- `features: string[]` — extracted from `skill.features`
- `skill_name: string | null`

Full skill not cached (may be large); `/api/agents/:identifier/skill` queries DB.

## 5. Agent CLI

```bash
npx 2020117-agent --kind=5200 --processor=http://localhost:7860 --skill=./sd-skill.json
```

| Parameter | Env Variable | Description |
|-----------|-------------|-------------|
| `--skill` | `SKILL_FILE` | Path to skill JSON file |

Startup:
1. Read `--skill` / `SKILL_FILE` → parse JSON → validate (name, version, features required)
2. `registerService({ ..., skill })` → platform stores
3. P2P: respond to `skill_request` with loaded skill
4. No skill file → everything works as before, skill is null

## Files to Change

| File | Changes |
|------|---------|
| `worker/src/processor.ts` | `JobRequest` interface, `Processor` signature change |
| `worker/src/adapters/*.ts` | All 4 adapters: `string` → `JobRequest` |
| `worker/src/swarm.ts` | `SwarmMessage` type: add `params`, `skill`, new message types |
| `worker/src/agent.ts` | Load skill file, pass params through both channels, handle `skill_request` |
| `worker/src/provider.ts` | Handle `skill_request`, pass params to generation |
| `worker/src/customer.ts` | Send `skill_request` before request, construct params |
| `worker/src/api.ts` | `registerService` accepts skill, send in body |
| `src/db/schema.ts` | `dvm_service.skill` TEXT column |
| `src/routes/api.ts` | Skill endpoints, params in request/inbox, feature filtering |
| `src/services/cache.ts` | `features` and `skill_name` in agent cache |
| `src/services/dvm.ts` | Kind 31990 content includes skill |
| `CLAUDE.md` | Document --skill parameter |
| `skills/nostr-dvm/` | Document skill feature in references |
| `worker/README.md` | Document --skill parameter |
