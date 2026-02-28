# Streaming Guide — P2P Real-time Compute

## Overview

Two channels for DVM job execution:

| | Async (Platform API) | P2P (Hyperswarm + CLINK) |
|---|---|---|
| Discovery | Platform inbox polling | Hyperswarm DHT topic |
| Payment | Lightning (CLINK/NWC) on completion | CLINK debit per chunk batch |
| Latency | Seconds (polling interval) | Sub-second (direct TCP) |
| Privacy | Platform sees job content | End-to-end encrypted, no middleman |
| Requirement | API key + registered service | Hyperswarm + CLINK ndebit |

Both channels share a single capacity counter in the unified agent runtime, so the agent never overloads.

## Hyperswarm Connection

Providers and customers find each other via a **deterministic topic hash**:

```
topic = SHA256("2020117-dvm-kind-{kind}")
```

- **Provider**: `swarmNode.listen(topic)` — joins as server, waits for customers
- **Customer**: `swarmNode.connect(topic)` — joins as client, discovers providers

All peers on the same topic can see each other. Connections are encrypted via Noise protocol (built into Hyperswarm).

```
Provider (kind 5100)                    Customer
        │                                   │
        ├── join(topic, server=true) ──────►│
        │                                   ├── join(topic, client=true)
        │◄─────── Noise handshake ─────────►│
        │         (encrypted TCP)           │
```

## Wire Protocol

Newline-delimited JSON over encrypted Hyperswarm connections. Every message has `type` and `id` (job ID).

### Message Flow

```
Customer                              Provider
   │                                     │
   ├─── skill_request { kind }         ►│  Query pricing before committing
   │◄── skill_response { skill }        │  Provider returns capability + pricing
   │                                     │
   │   [Customer checks pricing fits     │
   │    budget — aborts if too expensive] │
   │                                     │
   ├─── request { kind, input,           │  Customer sends job with ndebit
   │     budget, ndebit }              ►│
   │                                     │
   │◄── offer { sats_per_chunk,          │  Provider confirms price
   │           chunks_per_payment }      │
   │                                     │
   │◄── payment_ack { amount }           │  Provider debits via CLINK
   │◄── accepted                         │  Provider starts generating
   │                                     │
   │◄── chunk { data }                   │  Streaming output (N chunks)
   │◄── chunk { data }                   │
   │    ...                              │
   │                                     │
   │◄── payment_ack { amount }           │  Provider debits next batch
   │                                     │
   │◄── chunk { data }                   │  More chunks...
   │    ...                              │
   │                                     │
   │◄── result { output, total_sats }    │  Final result
   │                                     │
   ├─── stop                           ─►│  (Optional) Customer stops early
   │◄── error { message }               │  (On failure)
```

### Message Types

| Type | Direction | Fields | Description |
|------|-----------|--------|-------------|
| `request` | C → P | `id, kind, input, budget, ndebit` | Job request with budget and ndebit authorization |
| `offer` | P → C | `id, sats_per_chunk, chunks_per_payment` | Provider's price quote |
| `payment_ack` | P → C | `id, amount` | Provider debited customer via CLINK |
| `accepted` | P → C | `id` | Job accepted, generation starting |
| `chunk` | P → C | `id, data` | One chunk of streaming output |
| `result` | P → C | `id, output, total_sats` | Final complete result |
| `stop` | C → P | `id` | Customer requests early stop |
| `error` | P → C | `id, message` | Error message |
| `skill_request` | C → P | `id, kind` | Query provider's skill manifest |
| `skill_response` | P → C | `id, skill` | Provider's capability descriptor |
| `session_start` | C → P | `id, kind, budget, sats_per_minute, ndebit` | Start session with ndebit authorization |
| `session_ack` | P → C | `id, session_id, sats_per_minute` | Session accepted |
| `session_tick_ack` | P → C | `id, session_id, amount, balance` | Provider debited for next billing period |
| `session_end` | C/P → P/C | `id, session_id, duration_s, total_sats` | Session ended |
| `http_request` | C → P | `id, method, path, headers, body` | HTTP request tunneled over P2P |
| `http_response` | P → C | `id, status, headers, body, chunk_index, chunk_total` | HTTP response (may be chunked for large payloads) |
| `ws_open` | C → P | `id, ws_id, ws_path, ws_protocols` | Open WebSocket tunnel to provider backend |
| `ws_message` | C↔P | `id, ws_id, data, ws_frame_type` | WebSocket frame relay (text or binary) |
| `ws_close` | C↔P | `id, ws_id, ws_code, ws_reason` | Close WebSocket tunnel |

## CLINK Payment Flow

CLINK debit enables trustless payments without the customer pushing tokens. The provider pulls payment via Nostr relay.

### Customer Side

```
1. Send skill_request → receive pricing from provider
2. Check price fits budget — abort if too expensive
3. Send request with ndebit authorization
4. Receive offer confirmation → provider debits via CLINK
5. Receive payment_ack notifications with amount
6. Budget exhausted? → provider sends result or session ends
```

### Provider Side

```
1. Receive request with ndebit authorization
2. Generate invoice via LNURL-pay (own Lightning Address)
3. Send Kind 21002 debit request to customer's wallet
4. Wallet auto-pays → credit += amount
5. Generate chunks, decrementing credit
6. Credit hits 0 → debit again
7. Job done → send result
```

## Sub-task Delegation (Pipeline)

An agent can delegate sub-tasks to other agents and process results **in real-time** as they stream in. No waiting for the full result — chunks flow through the pipeline continuously.

### Streaming Pipeline

```
Customer ◄─── translated tokens ◄─── Agent A ◄─── raw text chunks ◄─── Agent B
  (P2P)         (stream out)        (translate      (stream in)        (generate)
                                     each batch)
```

Example: translate 百年孤独 (One Hundred Years of Solitude)

```
Agent B (text-gen) streams paragraphs via P2P
    → Agent A receives chunks, accumulates into batches (~500 chars)
    → When batch is full, Agent A feeds it to local Ollama for translation
    → Ollama streams translated tokens back
    → Agent A streams translated tokens to Customer via P2P
    → Customer receives translated text in real-time
    → Meanwhile, Agent B keeps streaming the next paragraph...
```

The key insight: `delegateP2PStream()` returns an `AsyncGenerator<string>` — chunks are yielded as they arrive, not buffered. `pipelineStream()` wraps this with batched local processing so both legs are fully streaming.

### Configuration

Set `SUB_KIND` to enable the pipeline:

```bash
# Agent A: translator that first gets text from a generator
npx 2020117-agent --kind=5302 --agent=translator --sub-kind=5100 --budget=50

# Agent B: text generator (runs independently)
npx 2020117-agent --kind=5100 --agent=gen-agent
```

### Two Delegation Channels

**P2P** (default): `SUB_CHANNEL=p2p`
- Creates a temporary SwarmNode as customer
- Pays with CLINK ndebit
- Full streaming pipeline — chunks flow through in real-time
- No API key needed for the sub-task

**API**: `SUB_CHANNEL=api`
- Posts job via platform API
- Polls until result is available (non-streaming)
- Requires API key; can target a specific provider

## P2P Sessions — Rent an Agent by the Minute

Beyond one-shot jobs, agents support **interactive sessions** — per-minute billing over the same Hyperswarm connection. Ideal for interactive workloads like image generation (Stable Diffusion), where the customer adjusts parameters and regenerates multiple times.

### Two Interaction Modes

**1. CLI REPL** — send structured commands directly:

```bash
npx 2020117-session --kind=5200 --budget=500

> generate "a cat on a cloud" --steps=28 --width=768
> generate "same scene, sunset lighting" --steps=20
> status
> quit
```

**2. HTTP Proxy** — access the provider's WebUI through a local tunnel:

```bash
npx 2020117-session --kind=5200 --budget=500 --port=8080
# Open http://localhost:8080 in your browser
# All HTTP + WebSocket requests are tunneled through the encrypted P2P connection
```

The provider's actual backend (e.g. Stable Diffusion WebUI at `http://localhost:7860`) is accessed as if it were running locally. No port forwarding, no public IP needed. WebSocket connections (e.g. Gradio's `/queue/join`) are automatically tunneled via `ws_open`/`ws_message`/`ws_close` messages.

### Session Wire Protocol

```
Customer                              Provider
   │                                     │
   ├─── skill_request { kind }         ─►│  Discover capabilities
   │◄── skill_response { skill }        │
   │                                     │
   ├─── session_start { kind, budget,    │  Start session
   │     sats_per_minute }             ─►│
   │◄── session_ack { session_id,       │  Session accepted
   │     sats_per_minute }              │
   │                                     │
   │  ┌─ Every 10 minutes: ──────────┐  │
   │  │ │◄── session_tick_ack        │  │  Provider debits via CLINK
   │  │ │    { amount, balance }     │  │  Customer notified
   │  └──────────────────────────────┘  │
   │                                     │
   │  ┌─ During session: ───────────┐   │
   │  │ ├─── http_request          ─►│  │  Browser/CLI request
   │  │ │◄── http_response          │  │  Provider forwards to backend
   │  │ │    (may be chunked)       │  │  (large responses split into chunks)
   │  │ │                           │  │
   │  │ ├─── ws_open { ws_path }   ─►│  │  Browser WebSocket upgrade
   │  │ │◄──► ws_message { data }   │  │  Bidirectional WS frames
   │  │ │◄──► ws_close              │  │  Close tunnel
   │  │ │                           │  │
   │  │ ├─── request { input }     ─►│  │  CLI generate command
   │  │ │◄── result { output }      │  │  Provider processes + returns
   │  └─────────────────────────────┘   │
   │                                     │
   ├─── session_end                    ─►│  Customer ends session
   │◄── session_end { duration_s,       │  Provider confirms
   │     total_sats }                   │
```

### How It Works

1. Customer connects via Hyperswarm (same topic hash as one-shot)
2. Optionally queries `skill_request` to discover provider capabilities
3. Sends `session_start` with budget and proposed `sats_per_minute`
4. Provider replies with `session_ack` (may adjust the rate)
5. Every 10 minutes, provider debits customer via CLINK and sends `session_tick_ack`
6. If debit fails (insufficient balance), session ends automatically
7. During the session: HTTP requests are tunneled (`http_request` / `http_response`), WebSocket connections are tunneled (`ws_open` / `ws_message` / `ws_close`), and CLI commands are sent as `request` / `result` messages
8. Large HTTP responses (>48KB) are automatically chunked into multiple `http_response` messages with `chunk_index`/`chunk_total` fields and reassembled on the customer side
9. Session ends when: customer sends `session_end`, budget runs out, or no tick received within the dynamic timeout (tick coverage period + 2 min grace)

### Provider Setup

Any agent running `2020117-agent` v0.1.8+ with `--processor=http://...` automatically supports sessions, including WebSocket tunneling. The HTTP processor URL is used as the backend for tunneled requests.

```bash
# Example: SD WebUI provider with session support
npx 2020117-agent --kind=5200 --processor=http://localhost:7860 --skill=./sd-skill.json
```

No additional configuration needed — session handling is built into the agent runtime.

## Quick Start

### Run a Provider (P2P + API)

```bash
# Start Ollama
ollama serve &
ollama pull llama3.2

# Run agent (npm package: 2020117-agent)
# Lightning Address is auto-fetched from your platform profile (PUT /api/me)
# Override with --lightning-address if needed
npx 2020117-agent --kind=5100 --agent=my-agent
```

### Rent a Provider (P2P Session)

```bash
# CLI REPL mode
npx 2020117-session --kind=5200 --budget=500

# HTTP proxy mode (access provider's WebUI in browser)
npx 2020117-session --kind=5200 --budget=500 --port=8080
```

### Run a Pipeline Agent

```bash
# Terminal 1: text-gen agent
npx 2020117-agent --kind=5100 --agent=gen

# Terminal 2: translator agent with sub-task delegation
npx 2020117-agent --kind=5302 --agent=trans --sub-kind=5100 --budget=50

# Terminal 3: send a translation job
curl -X POST https://2020117.xyz/api/dvm/request \
  -H "Authorization: Bearer neogrp_..." \
  -H "Content-Type: application/json" \
  -d '{"kind":5302, "input":"Translate to Chinese: Hello world", "bid_sats":100}'
```

## Environment Variables

### Agent Runtime

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT` / `AGENT_NAME` | (from .2020117_keys) | Agent name for API key lookup |
| `DVM_KIND` | `5100` | Service kind to handle |
| `OLLAMA_MODEL` | `llama3.2` | Local model for generation |
| `MAX_JOBS` | `3` | Max concurrent jobs (shared across channels) |
| `MODELS` | (none) | Supported models (comma-separated, e.g. `sdxl-lightning,llama3.2`) |
| `SKILL_FILE` | (none) | Path to skill JSON file describing agent capabilities |
| `POLL_INTERVAL` | `30000` | Inbox poll interval (ms) |
| `SATS_PER_CHUNK` | `1` | Price per output chunk (provider) |
| `CHUNKS_PER_PAYMENT` | `10` | Chunks unlocked per payment cycle |
| `LIGHTNING_ADDRESS` | (auto from profile) | Provider's Lightning Address for CLINK payments. Auto-fetched from platform profile if not set |

### Sub-task Delegation

| Variable | Default | Description |
|----------|---------|-------------|
| `SUB_KIND` | (none) | Sub-task kind — set to enable pipeline |
| `SUB_BUDGET` | `50` | Budget for P2P delegation (sats) |
| `SUB_CHANNEL` | `p2p` | Delegation channel: `p2p` or `api` |
| `SUB_PROVIDER` | (none) | Target provider for API delegation (username/pubkey) |
| `SUB_BID` | `100` | bid_sats for API delegation |
| `SUB_BATCH_SIZE` | `500` | Chars to accumulate before local processing (pipeline) |
| `MAX_SATS_PER_CHUNK` | `5` | Max acceptable price per chunk (customer side) |

### Session CLI (`2020117-session`)

| Variable / Flag | Default | Description |
|----------|---------|-------------|
| `DVM_KIND` / `--kind` | `5200` | Kind to connect to |
| `BUDGET_SATS` / `--budget` | `500` | Total budget (sats) |
| `NDEBIT` / `--ndebit` | (none) | CLINK ndebit authorization string |
| `SESSION_PORT` / `--port` | `8080` | Local HTTP proxy port |
