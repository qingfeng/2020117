# Payment Migration: Cashu/NWC → CLINK

## Goal

Replace Cashu micro-token payments and NWC wallet connections with CLINK protocol (noffer/ndebit) for all payment flows — P2P sessions, P2P streaming, and DVM one-shot jobs.

## Architecture

```
Before:  Customer → Cashu mint → split tokens → push to Provider → Provider claims from mint
After:   Customer → signs ndebit auth → Provider pulls via CLINK SDK → Lightning settles directly
```

All CLINK communication goes through Nostr relays (Kind 21001/21002), encrypted with NIP-44. No web server, no mint dependency.

## Prerequisites

- [x] Lightning.Pub node running (Mac mini Docker)
- [x] ShockWallet connected
- [x] LND synced
- [ ] Node funded + channel opened (needed for testing)

## SDK Reference

```bash
npm install @shocknet/clink-sdk
```

```typescript
import {
  ClinkSDK,
  ndebitEncode,
  decodeBech32,
  generateSecretKey,
  getPublicKey,
  newNdebitPaymentRequest,
} from '@shocknet/clink-sdk'

// Provider sends debit request to customer's wallet
const sdk = new ClinkSDK({
  privateKey: providerKey,
  relays: ['wss://relay.lightning.pub'],
  toPubKey: customerWalletPubkey,
  defaultTimeoutSeconds: 30,
})

const result = await sdk.Ndebit({
  bolt11: 'lnbc...',       // Provider-generated invoice
  pointer: 'session_xyz',  // Links to customer's budget authorization
})
// { res: 'ok', preimage: '...' } or { res: 'GFY', error: '...', code: 1-6 }
```

---

## Phase 1: P2P Session Payment (Cashu → CLINK Debit)

### Current Flow (session.ts ↔ agent.ts)

```
Customer                          Provider
  |  mint tokens (cashu)            |
  |  split into micro-tokens        |
  |                                 |
  |--- session_start ------------->|
  |<-- session_ack ---------------|
  |                                 |
  |--- session_tick {token} ------>|  (every minute)
  |<-- session_tick_ack -----------|
  |                                 |
  |--- session_end --------------->|
  |                  batchClaim()   |
```

### New Flow

```
Customer                          Provider                    Lightning.Pub
  |                                 |                              |
  |--- session_start {ndebit} ---->|                              |
  |<-- session_ack ---------------|                              |
  |                                 |                              |
  |                    (1 min passes, Provider generates invoice)  |
  |                                 |-- Ndebit(bolt11) ---------->|
  |                                 |   via Nostr relay            |
  |                                 |                   auto-pay   |
  |                                 |<-- {res:'ok', preimage} ----|
  |                                 |                              |
  |<-- session_tick_ack -----------|  (confirms minute paid)      |
  |                                 |                              |
  |--- session_end --------------->|  (final debit if needed)     |
```

### Key Design: Prepaid Per-Minute

Provider debits BEFORE providing each minute of service (except minute 1 which is debited at session_start):

1. Session starts → Provider debits minute 1 → success → start serving
2. Minute 1 ends → Provider debits minute 2 → success → continue
3. Debit fails → stop service immediately
4. Max provider loss: 0 (always paid before work)

### Files to Change

#### 1. `worker/package.json`
- Add: `@shocknet/clink-sdk`
- Keep `@cashu/cashu-ts` for now (Phase 2 removes it)

#### 2. New: `worker/src/clink.ts`

CLINK payment utilities:

```typescript
import { ClinkSDK, decodeBech32, generateSecretKey, getPublicKey } from '@shocknet/clink-sdk'

// Agent's persistent Nostr identity for CLINK
let agentKey: Uint8Array | null = null

export function initClinkAgent(): { privateKey: Uint8Array; pubkey: string } {
  agentKey = generateSecretKey()
  return { privateKey: agentKey, pubkey: getPublicKey(agentKey) }
}

export interface DebitResult {
  ok: boolean
  preimage?: string
  error?: string
}

// Provider calls this to debit customer's wallet
export async function debitCustomer(opts: {
  ndebit: string           // customer's ndebit1... authorization
  bolt11: string           // provider-generated invoice
  timeoutSeconds?: number
}): Promise<DebitResult> {
  if (!agentKey) throw new Error('CLINK agent not initialized')

  const decoded = decodeBech32(opts.ndebit)
  if (decoded.type !== 'ndebit') throw new Error('Invalid ndebit string')

  const sdk = new ClinkSDK({
    privateKey: agentKey,
    relays: [decoded.data.relay],
    toPubKey: decoded.data.pubkey,
    defaultTimeoutSeconds: opts.timeoutSeconds ?? 30,
  })

  const result = await sdk.Ndebit({
    bolt11: opts.bolt11,
    pointer: decoded.data.pointer,
  })

  if (result.res === 'ok') {
    return { ok: true, preimage: result.preimage }
  }
  return { ok: false, error: result.error }
}
```

#### 3. `worker/src/swarm.ts` — SwarmMessage changes

Remove `token` field from session messages, add `ndebit`:

```typescript
// session_start now carries ndebit authorization instead of nothing
// session_tick no longer carries token
// New: session_debit_ok / session_debit_fail for debit results
```

#### 4. `worker/src/session.ts` — Customer Side

Remove:
- `createWallet()`, `mintTokens()`, `splitTokens()` calls (~40 lines)
- `sendTick()` token logic
- `microTokens` state, `tokenIndex`

Add:
- Send `ndebit` pointer in `session_start` message
- Customer configures their wallet's ndebit authorization via CLI arg `--ndebit`
- No tick sending needed — Provider pulls payments independently

#### 5. `worker/src/agent.ts` — Provider Side

Remove:
- `peekToken()` calls in session_tick handler
- `batchClaim()` calls in endSession/peer-leave
- `session.tokens` accumulation

Add:
- On `session_start`: extract `ndebit` from message, store in session state
- Tick timer: every minute, generate invoice via Lightning.Pub → call `debitCustomer()` → if ok, continue; if fail, end session
- Need Lightning.Pub connection for invoice generation (new CLI arg `--lightning-pub`)

### New CLI Arguments

| Arg | Env Var | Used By | Purpose |
|-----|---------|---------|---------|
| `--ndebit` | `CLINK_NDEBIT` | Customer (session.ts) | Customer's ndebit authorization string |
| `--lightning-pub` | `LIGHTNING_PUB_NPROFILE` | Provider (agent.ts) | Lightning.Pub nprofile for generating invoices |

### Invoice Generation

Provider needs to generate Lightning invoices. Two approaches:

**Option A: Via Lightning.Pub gRPC (direct)**
- Agent connects to Lightning.Pub's LND via gRPC
- Generates invoices locally
- Requires LND cert + macaroon access

**Option B: Via CLINK Offers (self-request)**
- Provider has a noffer on their Lightning.Pub
- Provider requests invoice from own node via Noffer
- Simpler but adds a Nostr round-trip

**Chosen: Option A** — direct LND gRPC for speed. The agent already runs alongside Lightning.Pub.

---

## Phase 2: P2P Streaming Payment (Cashu → CLINK Debit)

Same pattern as Phase 1 but for chunk-based streaming:

### New Flow

```
Customer sends ndebit with budget
  → Provider debits first payment (N chunks worth)
  → Provider streams chunks until credit exhausted
  → Provider debits next payment
  → Debit fails → stop streaming
```

### Files to Change

- `worker/src/p2p-customer.ts` — Remove mintTokens/splitTokens, send ndebit in request
- `worker/src/p2p-provider.ts` — Remove handlePayment/batchClaim, add debit-per-cycle
- `worker/src/cashu.ts` — Can be deleted after this phase

---

## Phase 3: Server DVM Payment (NWC → CLINK Offers)

### Current Flow

```
Customer completes job → Server decrypts NWC URI → WebSocket to relay → NIP-47 pay_invoice
```

### New Flow

```
Customer completes job → Server sends CLINK debit request → Customer wallet auto-pays
```

### Files to Change

- New: `src/services/clink.ts` — Server-side CLINK integration
- `src/routes/api.ts` — DVM complete endpoint
- `src/db/schema.ts` — Add `clink_ndebit` to user table
- `src/services/nwc.ts` — Deprecated (keep for backward compat)

---

## Phase 4: Platform Fee (ndebit-based)

### Flow

```
Provider registers service → signs ndebit to platform
  → P2P sessions happen, heartbeat reports earned_sats
  → Cron calculates 5% fee → debit from provider
  → Debit fails → ban pubkey from NIP-90 broadcast
```

### Files to Change

- `src/db/schema.ts` — Add `platform_ndebit` to dvm_service
- `src/routes/api.ts` — Require ndebit on service registration
- New: `src/services/platform-fee.ts`
- `src/index.ts` — Cron job

---

## Deleted Code After Full Migration

| File | Lines | Status |
|------|-------|--------|
| `worker/src/cashu.ts` | 128 | Delete after Phase 2 |
| `src/services/nwc.ts` | 217 | Deprecate after Phase 3 |
| `@cashu/cashu-ts` dep | — | Remove from package.json |

## Execution Order

1. **Phase 1** — P2P Session (session.ts + agent.ts) ← START HERE
2. **Phase 2** — P2P Streaming (p2p-customer.ts + p2p-provider.ts)
3. **Phase 3** — Server DVM (routes/api.ts + new clink.ts)
4. **Phase 4** — Platform Fee (new feature)
