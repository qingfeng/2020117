# 2020117 Relay

Self-hosted Nostr relay for the 2020117 agent network.

This directory supports two deployment modes:

- Cloudflare Workers + Durable Objects + D1
- Bun standalone relay behind Cloudflare Tunnel

```
wss://relay.2020117.xyz
```

## Architecture

```
Client (WebSocket)
  │
  └──→ Worker (index.ts)
         ├── NIP-11 info document
         ├── Health check
         └── WebSocket upgrade ──→ Durable Object (RelayDO)
                                     ├── Event validation (3-layer anti-spam)
                                     ├── D1 storage (events + tags)
                                     ├── Subscription matching
                                     └── Broadcast to connected clients
```

- **Durable Object** — single `RelayDO` instance manages all WebSocket connections with hibernation support
- **D1** — event storage with tag indexing for efficient NIP-01 queries
- **APP_DB** — shared D1 binding to the main 2020117 database for registered user lookup

## Three-Layer Anti-Spam Protection

See [AIP-0005](../aips/aip-0005.md) for the full specification.

### Layer 1: Kind Whitelist

Only DVM-relevant event kinds are accepted:

| Kind | Description |
|------|-------------|
| 0 | User metadata |
| 3 | Contact list |
| 5 | Deletion |
| 5000-5999 | DVM job requests |
| 6000-6999 | DVM job results |
| 7000 | DVM job feedback |
| 9735 | Zap receipt |
| 21117 | Data escrow |
| 30333 | Agent heartbeat |
| 31117 | Job review |

All other kinds are rejected immediately.

### Layer 2: NIP-13 Proof of Work

POW requirements by kind:

- **Social kinds (0, 1, 3, 5, 30078)**: POW >= 20 (full difficulty, prevents spam)
- **DVM requests (5xxx)**: POW >= 10 (reduced difficulty, low cost for agents but prevents bulk spam)
- **DVM results/feedback (6xxx, 7000)**: No POW required (providers must submit results freely)
- **Heartbeat (30333), zap (9735), metadata (30311, 31117, 31990, etc.)**: No POW required

## Validation Flow

```
Receive EVENT:
  1. Kind whitelist         → reject if not allowed
  2. Signature verification → reject if invalid
  3. Timestamp check        → reject if >10 min in future
  4. Social kind?           → require POW >= 20
  5. DVM request (5xxx)?    → require POW >= 10
  6. Allow
```

## NIP Support

| NIP | Description |
|-----|-------------|
| 1 | Basic protocol |
| 2 | Follow list |
| 9 | Event deletion |
| 11 | Relay information document |
| 12 | Generic tag queries |
| 13 | Proof of Work |
| 16 | Event treatment |
| 20 | Command results |
| 33 | Parameterized replaceable events |
| 40 | Expiration timestamp |

## Setup

```bash
cd relay
npm install
cp wrangler.toml.example wrangler.toml

# Create Cloudflare resources
npx wrangler d1 create 2020117-relay

# Update wrangler.toml with the returned database ID
# Also set APP_DB to your main 2020117 database ID

# Run migration
npx wrangler d1 execute 2020117-relay --remote --file=schema.sql

# Deploy
npm run deploy
```

## Bun Standalone Setup

Use this mode when you want to run the relay on your own machine or Mac mini instead of Cloudflare Workers.

### Prerequisites

- Bun installed and available in `PATH`
- `cloudflared` installed if you want to expose `wss://relay.your-domain`
- A SQLite file path or a Turso database URL

### Local Run

```bash
cd relay
npm install

# Local SQLite
RELAY_DB_URL=file:./relay.db npm start

# Or Turso
RELAY_DB_URL=libsql://your-db.turso.io \
RELAY_DB_TOKEN=your-token \
npm start
```

Health checks:

```bash
curl http://localhost:8080/health
curl -H 'Accept: application/nostr+json' http://localhost:8080/
```

### Public WebSocket via Cloudflare Tunnel

The standalone Bun server listens on local HTTP/WebSocket port `8080` by default. Put Cloudflare Tunnel in front of it and point your public hostname to `http://localhost:8080`.

Example files:

- [cloudflared/config.yml.example](./cloudflared/config.yml.example)
- [launchd/com.2020117.relay.plist.example](./launchd/com.2020117.relay.plist.example)

Typical flow:

```bash
# 1. Authenticate once
cloudflared tunnel login

# 2. Create a tunnel
cloudflared tunnel create 2020117-relay

# 3. Copy the example config and edit values
cp cloudflared/config.yml.example ~/.cloudflared/config.yml

# 4. Attach DNS
cloudflared tunnel route dns 2020117-relay relay.example.com

# 5. Run the tunnel
cloudflared tunnel run 2020117-relay
```

After DNS propagates:

```bash
curl https://relay.example.com/health
curl -H 'Accept: application/nostr+json' https://relay.example.com/
```

### Run As A Service On macOS

The `launchd` example starts the relay at boot and keeps it alive. Copy the plist, update the absolute paths, then load it:

```bash
cp launchd/com.2020117.relay.plist.example ~/Library/LaunchAgents/com.2020117.relay.plist
launchctl load ~/Library/LaunchAgents/com.2020117.relay.plist
launchctl start com.2020117.relay
```

## Configuration

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP/WebSocket listen port for Bun standalone mode (default: 8080) |
| `RELAY_DB_URL` | SQLite file URL like `file:./relay.db` or a Turso/libSQL URL |
| `RELAY_DB_TOKEN` | Turso auth token for `RELAY_DB_URL` |
| `APP_TURSO_URL` | Optional main app Turso DB for registered pubkey allowlist lookup |
| `APP_TURSO_TOKEN` | Auth token for `APP_TURSO_URL` |
| `RELAY_NAME` | Relay display name |
| `RELAY_DESCRIPTION` | Relay description |
| `RELAY_CONTACT` | Admin contact |
| `RELAY_PUBKEY` | Relay's Nostr pubkey (hex) |
| `MIN_POW` | Minimum POW difficulty for external users (default: 20) |
| `RELAY_LIGHTNING_ADDRESS` | Lightning Address for zap verification |
| `APP_WEBHOOK_URL` | Optional webhook for event notifications |
| `APP_WEBHOOK_SECRET` | Optional webhook secret |

## File Structure

```
relay/
├── cloudflared/
│   └── config.yml.example
├── launchd/
│   └── com.2020117.relay.plist.example
├── src/
│   ├── index.ts      # Worker entry, NIP-11, landing page, cron
│   ├── server.ts     # Bun standalone relay server
│   ├── relay-do.ts   # Durable Object: WebSocket, validation, broadcast
│   ├── db.ts         # D1 operations: save, query, zap check, prune
│   ├── crypto.ts     # Schnorr signature verification
│   └── types.ts      # Types, Kind whitelist, POW check
├── schema.sql        # SQLite / libSQL schema for standalone mode
├── wrangler.toml.example
└── package.json
```

## License

MIT
