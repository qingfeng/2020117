# P2P Interactive Session — Design Document

## Problem

Current P2P model is one-shot: connect → request → result → disconnect. This doesn't leverage Hyperswarm's real value — persistent, direct connections. For use cases like image generation (Stable Diffusion), users need to iterate: generate, adjust params, regenerate, dozens of times. Doing this via the API channel means creating dozens of separate jobs with platform overhead each time.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Payment model | Per-minute (time-based) | Session = renting the service; pay for access, not per-task |
| Disconnect handling |断即停，不退不补 | Simple, no state recovery complexity |
| Client modes | CLI REPL + HTTP proxy (same process) | CLI for agent-driven interaction, HTTP proxy for browser direct access |
| Web UI | Proxy Provider's actual WebUI | No custom UI needed; works with any backend (SD WebUI, ComfyUI, etc.) |
| Session scope | New file (session.ts), extend swarm.ts + agent.ts | Don't touch existing one-shot flow |

## 1. Session Wire Protocol

New message types added to SwarmMessage:

| Type | Direction | Fields | Purpose |
|------|-----------|--------|---------|
| `session_start` | Customer → Provider | `id, budget, sats_per_minute` | Open session, start billing |
| `session_ack` | Provider → Customer | `id, session_id, sats_per_minute` | Confirm session, agree on rate |
| `session_tick` | Customer → Provider | `id, session_id, token` | Periodic Cashu payment (every minute) |
| `session_tick_ack` | Provider → Customer | `id, session_id, balance` | Confirm payment, return remaining balance |
| `session_end` | Either → Either | `id, session_id, total_sats, duration_s` | End session, final accounting |
| `http_request` | Customer → Provider | `id, session_id, method, path, headers, body` | HTTP proxy request |
| `http_response` | Provider → Customer | `id, status, headers, body` | HTTP proxy response |

Within an active session, existing `request`/`result`/`error` messages are reused for CLI-driven generation (non-proxy mode).

### Session Flow

```
Customer                              Provider
   |                                     |
   |--- skill_request ----------------->|
   |<-- skill_response -----------------|  (includes pricing.sats_per_minute)
   |                                     |
   |--- session_start { budget,      -->|  "I want to rent your service"
   |      sats_per_minute }              |
   |<-- session_ack { session_id,    ---|  "Agreed, billing started"
   |      sats_per_minute }              |
   |                                     |
   |--- session_tick { token }       -->|  (automatic, every minute)
   |<-- session_tick_ack { balance } ---|
   |                                     |
   |  === Session active: two modes === |
   |                                     |
   |  Mode 1: CLI generate              |
   |--- request { id, input, params } ->|  (can send many times)
   |<-- result { id, output }        ---|
   |                                     |
   |  Mode 2: HTTP proxy                |
   |--- http_request { method,       -->|  (browser → localhost → P2P)
   |      path, headers, body }          |
   |<-- http_response { status,      ---|  (Provider forwards to local backend)
   |      headers, body }                |
   |                                     |
   |--- session_end ------------------->|  (user quits or budget exhausted)
   |<-- session_end --------------------|  (final accounting)
```

### Provider Timeout

If Provider doesn't receive a `session_tick` for 2 consecutive tick periods (2 minutes), it sends `session_end` and stops accepting requests.

## 2. Local Proxy Architecture

```
┌─────────────────────────────────────────┐
│           2020117-session               │
│                                         │
│  ┌─────────┐   ┌──────────────────┐     │
│  │ CLI REPL │   │ HTTP :8080       │     │
│  │ (stdin)  │   │                  │     │
│  │ generate │   │ /* → P2P proxy   │←── Browser (Provider's WebUI)
│  │ status   │   │                  │     │
│  │ quit     │   │                  │     │
│  └────┬─────┘   └───────┬─────────┘     │
│       │                 │               │
│       └────────┬────────┘               │
│                ▼                        │
│  ┌──────────────────────┐               │
│  │ Session Manager      │               │
│  │ - P2P connection     │               │
│  │ - Cashu tick timer   │               │
│  │ - Request routing    │               │
│  └──────────┬───────────┘               │
│             ▼                           │
│  ┌──────────────────────┐               │
│  │ Hyperswarm P2P       │──── Remote Provider
│  └──────────────────────┘               │
└─────────────────────────────────────────┘
```

One process, two entry points:

- **CLI REPL**: `generate "prompt" --steps=40` → sends `request` message → saves result to local file
- **HTTP proxy**: Browser hits `localhost:8080/*` → wraps as `http_request` → Provider forwards to its backend → response proxied back

Both share the same P2P session and payment stream.

## 3. Billing & Payment

- Provider declares `pricing.sats_per_minute` in skill JSON
- Customer starts with `--budget=500`, mints one big Cashu token
- On `session_ack`, split token into N micro-tokens (budget / sats_per_minute)
- Timer fires every 60 seconds, sends `session_tick` with next micro-token
- Provider peeks token to verify amount, accumulates for batch claim at session end
- When remaining < 2 tokens, CLI warns "low balance"
- When tokens exhausted, auto `session_end`

### Example

```
Provider rate:  10 sats/min
Customer budget: 500 sats

mint 500 sats → split into 50 × 10-sats tokens
50 minutes of session time

Minute 48: CLI warns "⚠ 20 sats remaining (≈2 min)"
Minute 50: tokens exhausted → session_end → disconnect
```

### Skill Pricing Extension

```json
{
  "name": "sd-webui",
  "version": "1.0",
  "features": ["controlnet", "lora"],
  "pricing": {
    "mode": "per_minute",
    "sats_per_minute": 10
  }
}
```

## 4. HTTP Proxy Tunnel

Local HTTP server receives browser requests, wraps them as `http_request` messages over P2P, Provider forwards to its local backend.

```
Browser GET /                    → http_request { method: "GET", path: "/" }
Provider: fetch("http://localhost:7860/") → http_response { status: 200, body: "<html>..." }

Browser POST /sdapi/v1/txt2img  → http_request { method: "POST", path: "/sdapi/v1/txt2img", body: ... }
Provider: fetch("http://localhost:7860/sdapi/v1/txt2img", ...) → http_response { status: 200, body: ... }
```

**Security**: Provider only forwards to its declared backend URL (`--processor=http://localhost:7860`). Path is appended to that base URL. No arbitrary URL access.

## 5. CLI Interactive Mode

```bash
$ npx 2020117-session --kind=5200 --budget=500 --port=8080

[session] Connected to sd_webui_qingfeng
[session] Skill: sd-webui v1.0 (controlnet, lora, adetailer, hires_fix)
[session] Pricing: 10 sats/min
[session] Budget: 500 sats (≈50 min)
[session] Web proxy ready at http://localhost:8080
[session] Type 'help' for commands

> generate "a cat astronaut on the moon" --steps=28 --width=768
[session] Generating... (14.2s)
[session] Saved: ./output/001.png

> generate "a cat astronaut on the moon, close up" --steps=40 --cfg=12
[session] Generating... (18.7s)
[session] Saved: ./output/002.png

> status
[session] Connected: 4m32s | Spent: 50 sats | Remaining: 450 sats (≈45 min)

> quit
[session] Session ended. Total: 50 sats for 5 minutes.
```

| Command | Description |
|---------|-------------|
| `generate "prompt" --key=val` | Generate, save result to local file |
| `status` | Balance, duration, connection info |
| `skill` | Show Provider capabilities |
| `quit` | End session |

## 6. Files to Change

| File | Changes |
|------|---------|
| Create: `worker/src/session.ts` | Main entry: CLI args, Session Manager, REPL, HTTP proxy server |
| Modify: `worker/src/swarm.ts` | SwarmMessage: add session_start/ack/tick/tick_ack/end, http_request/response types and fields |
| Modify: `worker/src/agent.ts` | Provider: handle session messages, tick payment collection, http_request forwarding, session timeout |
| Modify: `worker/package.json` | Add `2020117-session` to bin |
| Modify: `worker/README.md` | Document session command |
| Modify: `CLAUDE.md` | Document session command and parameters |

No changes to: `customer.ts`, `provider.ts`, `pipeline.ts`, `cashu.ts`, platform side.

## CLI Parameters

| Parameter | Env Variable | Description |
|-----------|-------------|-------------|
| `--kind` | `DVM_KIND` | DVM kind (default: 5200) |
| `--budget` | `SESSION_BUDGET` | Total budget in sats |
| `--port` | `SESSION_PORT` | HTTP proxy port (default: 8080) |
| `--agent` | `AGENT` | Agent name (for API key lookup) |
| `--provider` | `SESSION_PROVIDER` | Specific provider to connect to (optional) |
