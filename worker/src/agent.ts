#!/usr/bin/env node
/**
 * Agent Runtime — Nostr-native daemon that handles:
 *   1. DVM requests via relay subscription (Kind 5xxx → process → Kind 6xxx result)
 *   2. P2P sessions (Hyperswarm + Lightning invoice per-minute billing)
 *
 * All agents sign Nostr events with their own private key and publish directly
 * to relays. The platform API is only used for read operations (pipeline sub-tasks).
 *
 * Usage:
 *   AGENT=translator DVM_KIND=5302 OLLAMA_MODEL=qwen2.5:0.5b npm run agent
 *   AGENT=my-agent DVM_KIND=5100 MAX_JOBS=5 npm run agent
 *   AGENT=broker DVM_KIND=5302 PROCESSOR=none SUB_KIND=5100 npm run agent
 *   AGENT=custom DVM_KIND=5100 PROCESSOR=exec:./my-model.sh npm run agent
 *   AGENT=remote DVM_KIND=5100 PROCESSOR=http://localhost:8080 npm run agent
 */

// --- CLI args → env (for npx usage) ---
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--')) continue
  const eq = arg.indexOf('=')
  if (eq === -1) {
    // Bare flags (no value)
    if (arg === '--sovereign') {} // legacy flag, all agents are now Nostr-native
    if (arg === '--p2p-only') process.env.P2P_ONLY = 'true'
    continue
  }
  const key = arg.slice(0, eq)
  const val = arg.slice(eq + 1)
  switch (key) {
    case '--kind':         process.env.DVM_KIND = val; break
    case '--processor':    process.env.PROCESSOR = val; break
    case '--model':        process.env.OLLAMA_MODEL = val; break
    case '--agent':        process.env.AGENT = val; break
    case '--max-jobs':     process.env.MAX_JOBS = val; break
    case '--sub-kind':     process.env.SUB_KIND = val; break
    case '--sub-provider': process.env.SUB_PROVIDER = val; break
    case '--sub-bid':      process.env.SUB_BID = val; break
    case '--api-key':      break // legacy, ignored
    case '--api-url':      break // legacy, ignored
    case '--models':       process.env.MODELS = val; break
    case '--skill':        process.env.SKILL_FILE = val; break
    case '--lightning-address': process.env.LIGHTNING_ADDRESS = val; break
    case '--sovereign':    break // legacy flag, all agents are now Nostr-native
    case '--privkey':      process.env.NOSTR_PRIVKEY = val; break
    case '--nwc':          process.env.NWC_URI = val; break
    case '--relays':       process.env.NOSTR_RELAYS = val; break
    case '--p2p-only':     process.env.P2P_ONLY = val; break
  }
}

import { randomBytes, createHash } from 'crypto'
import { createConnection } from 'net'
import { SwarmNode, topicFromKind, SwarmMessage } from './swarm.js'
import { createProcessor, Processor } from './processor.js'
import {
  generateKeypair, loadSovereignKeys, saveSovereignKeys, loadAgentName,
  signEvent, signEventWithPow, nip44Encrypt, nip44Decrypt, pubkeyFromPrivkey,
  RelayPool,
} from './nostr.js'
import type { NostrEvent, SovereignKeys } from './nostr.js'
import { parseNwcUri, nwcGetBalance, nwcPayLightningAddress, nwcMakeInvoice } from './nwc.js'
import type { NwcParsed } from './nwc.js'
import { readFileSync } from 'fs'
import WebSocket from 'ws'
// Polyfill global WebSocket for Node.js < 22 (needed by ws tunnel)
if (!globalThis.WebSocket) (globalThis as any).WebSocket = WebSocket

// --- Config from env ---

const KIND = Number(process.env.DVM_KIND) || 5100
const MAX_CONCURRENT = Number(process.env.MAX_JOBS) || 3
const P2P_ONLY = process.env.P2P_ONLY === 'true' || process.env.P2P_ONLY === '1'
const SATS_PER_CHUNK = Number(process.env.SATS_PER_CHUNK) || 1
const CHUNKS_PER_PAYMENT = Number(process.env.CHUNKS_PER_PAYMENT) || 10

// --- Lightning payment config ---
let LIGHTNING_ADDRESS = process.env.LIGHTNING_ADDRESS || ''

// --- Relay config ---
const DEFAULT_RELAYS = ['wss://relay.2020117.xyz', 'wss://relay.damus.io', 'wss://nos.lol']
const RELAYS = process.env.NOSTR_RELAYS?.split(',').map(s => s.trim()) || DEFAULT_RELAYS

// --- Sub-task delegation config ---
const SUB_KIND = process.env.SUB_KIND ? Number(process.env.SUB_KIND) : null
const SUB_PROVIDER = process.env.SUB_PROVIDER || undefined
const SUB_BID = Number(process.env.SUB_BID) || 100
const MIN_BID_SATS = Number(process.env.MIN_BID_SATS) || SATS_PER_CHUNK * CHUNKS_PER_PAYMENT  // default = pricing per job

// --- Skill file loading ---

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

// --- State ---

interface AgentState {
  agentName: string | null
  activeJobs: number
  shuttingDown: boolean
  stopHeartbeat: (() => void) | null
  swarmNode: SwarmNode | null
  processor: Processor | null
  skill: Record<string, unknown> | null
  // P2P session lifetime counters (in-memory, resets on restart)
  p2pSessionsCompleted: number
  p2pTotalEarnedSats: number
  // Nostr identity + relay
  sovereignKeys: SovereignKeys | null
  relayPool: RelayPool | null
  nwcParsed: NwcParsed | null
}

const state: AgentState = {
  agentName: loadAgentName(),
  activeJobs: 0,
  shuttingDown: false,
  stopHeartbeat: null,
  swarmNode: null,
  processor: null,
  skill: loadSkill(),
  p2pSessionsCompleted: 0,
  p2pTotalEarnedSats: 0,
  sovereignKeys: null,
  relayPool: null,
  nwcParsed: null,
}

// --- Capacity management ---

function acquireSlot(): boolean {
  if (state.shuttingDown) return false
  if (state.activeJobs >= MAX_CONCURRENT) return false
  state.activeJobs++
  return true
}

function releaseSlot(): void {
  if (state.activeJobs > 0) state.activeJobs--
}

function getAvailableCapacity(): number {
  return MAX_CONCURRENT - state.activeJobs
}

// --- Main ---

async function main() {
  const label = state.agentName || 'agent'
  console.log(`[${label}] Starting agent runtime`)

  // 1. Create and verify processor
  state.processor = await createProcessor()
  console.log(`[${label}] kind=${KIND} processor=${state.processor.name} maxJobs=${MAX_CONCURRENT}`)
  if (SUB_KIND) {
    console.log(`[${label}] Pipeline: sub-task kind=${SUB_KIND} (bid=${SUB_BID}${SUB_PROVIDER ? `, provider=${SUB_PROVIDER}` : ''})`)
  } else if (state.processor.name === 'none') {
    console.warn(`[${label}] WARNING: processor=none without SUB_KIND — generate() will pass through input as-is`)
  }
  await state.processor.verify()
  console.log(`[${label}] Processor "${state.processor.name}" verified`)

  if (state.skill) {
    console.log(`[${label}] Skill: ${state.skill.name} v${state.skill.version} (${(state.skill.features as string[]).join(', ')})`)
  }

  // 2. Auto-load Lightning Address from .2020117_keys if not set via CLI/env
  if (!LIGHTNING_ADDRESS) {
    const keys = loadSovereignKeys(loadAgentName() || 'agent')
    if (keys?.lightning_address) {
      LIGHTNING_ADDRESS = keys.lightning_address
      console.log(`[${label}] Lightning Address loaded from keys: ${LIGHTNING_ADDRESS}`)
    }
  }

  // 3. Nostr identity + relay + subscriptions (all agents are Nostr-native)
  await setupNostr(label)

  // 4. P2P swarm listener
  await startSwarmListener(label)

  // 5. Graceful shutdown
  setupShutdown(label)

  console.log(`[${label}] Agent ready\n`)
}

// --- 2. Nostr Setup (all agents are Nostr-native) ---

async function setupNostr(label: string) {
  const agentName = state.agentName || 'agent'

  // 1. Load or generate Nostr keys
  let keys = loadSovereignKeys(agentName)

  if (!keys?.privkey) {
    const privkey = process.env.NOSTR_PRIVKEY
    if (privkey) {
      keys = {
        ...(keys || {} as SovereignKeys),
        privkey,
        pubkey: pubkeyFromPrivkey(privkey),
        nwc_uri: process.env.NWC_URI,
        relays: RELAYS,
        lightning_address: LIGHTNING_ADDRESS || undefined,
      }
    } else {
      const kp = generateKeypair()
      keys = {
        ...(keys || {} as SovereignKeys),
        privkey: kp.privkey,
        pubkey: kp.pubkey,
        nwc_uri: process.env.NWC_URI,
        relays: RELAYS,
        lightning_address: LIGHTNING_ADDRESS || undefined,
      }
      console.log(`[${label}] Generated new Nostr keypair: ${kp.pubkey}`)
    }
    saveSovereignKeys(agentName, keys)
  }

  // Apply NWC/relays from env if not already in keys
  if (!keys.nwc_uri && process.env.NWC_URI) keys.nwc_uri = process.env.NWC_URI
  if (!keys.relays?.length) keys.relays = RELAYS
  if (!keys.lightning_address && LIGHTNING_ADDRESS) keys.lightning_address = LIGHTNING_ADDRESS

  state.sovereignKeys = keys
  console.log(`[${label}] Identity: ${keys.pubkey}`)

  // 2. Parse NWC URI if available
  const nwcUri = keys.nwc_uri || process.env.NWC_URI
  if (nwcUri) {
    try {
      state.nwcParsed = parseNwcUri(nwcUri)
      const { balance_msats } = await nwcGetBalance(state.nwcParsed)
      console.log(`[${label}] NWC wallet connected (balance: ${Math.floor(balance_msats / 1000)} sats)`)
    } catch (e: any) {
      console.warn(`[${label}] NWC connection failed: ${e.message}`)
      state.nwcParsed = null
    }
  }

  // 3. Connect to relay pool
  const relayUrls = keys.relays || RELAYS
  console.log(`[${label}] Connecting to ${relayUrls.length} relay(s)...`)
  state.relayPool = new RelayPool(relayUrls)
  await state.relayPool.connect()
  console.log(`[${label}] Connected to ${state.relayPool.connectedCount} relay(s)`)

  // 4. Publish profile (Kind 0) — name, about, lud16
  await publishProfile(label)

  // 5. Publish ai.info (Kind 31340) — NIP-XX capability advertisement
  await publishAiInfo(label)

  // 6. Publish handler info (Kind 31990) — NIP-89 DVM capability (always, even P2P-only)
  await publishHandlerInfo(label)

  // 7. Subscribe to NIP-XX prompts (Kind 25802)
  subscribeNipXX(label)

  // 8. Subscribe to DVM requests (Kind 5xxx)
  // P2P-only: skip relay subscription entirely — only serve P2P customers
  if (!P2P_ONLY) {
    subscribeDvmRequests(label)
    subscribeDvmResults(label)
  }

  // 9. Start heartbeat (Kind 30333 to relay)
  const pricing: Record<string, number> = {}
  const priceSats = SATS_PER_CHUNK * CHUNKS_PER_PAYMENT
  if (priceSats > 0) pricing[String(KIND)] = priceSats

  state.stopHeartbeat = startNostrHeartbeat(label, state.sovereignKeys, state.relayPool, {
    pricing,
    p2pStatsFn: () => ({
      sessions: state.p2pSessionsCompleted,
      earned_sats: state.p2pTotalEarnedSats,
      active: activeSessions.size > 0,
    }),
  })

  // 10. Print startup summary
  const relays = (keys.relays || RELAYS).join(', ')
  console.log('')
  console.log(`═══════════════════════════════════════════════`)
  console.log(`  Agent ready: ${agentName}`)
  console.log(`  Pubkey:      ${keys.pubkey}`)
  console.log(`  Kind:        ${KIND}`)
  console.log(`  Relays:      ${relays}`)
  console.log(`  Lightning:   ${LIGHTNING_ADDRESS || '(not set)'}`)
  console.log(`  NWC wallet:  ${state.nwcParsed ? 'connected' : '(not set)'}`)
  console.log(`  Processor:   ${state.processor?.name || 'none'}`)
  console.log(`  Mode:        ${P2P_ONLY ? 'P2P-only (DVM disabled)' : 'DVM + P2P'}`)
  console.log(`═══════════════════════════════════════════════`)
  console.log('')
}

async function publishAiInfo(label: string) {
  if (!state.sovereignKeys || !state.relayPool) return

  const info: Record<string, unknown> = {
    ver: 1,
    supports_streaming: false,
    encryption: ['nip44'],
    supported_models: state.processor?.name ? [state.processor.name] : [],
    default_model: state.processor?.name || 'default',
    dvm_compatible: true,
    dvm_kinds: [KIND],
    pricing_hints: {
      currency: 'BTC',
      sats_per_prompt: SATS_PER_CHUNK * CHUNKS_PER_PAYMENT,
    },
    payment: {
      methods: ['invoice'],
      lightning_address: LIGHTNING_ADDRESS || undefined,
    },
  }

  const event = signEvent({
    kind: 31340,
    tags: [['d', 'agent-info']],
    content: JSON.stringify(info),
  }, state.sovereignKeys.privkey)

  const ok = await state.relayPool.publish(event)
  console.log(`[${label}] Published ai.info (Kind 31340): ${ok ? 'ok' : 'failed'}`)
}

async function publishProfile(label: string) {
  if (!state.sovereignKeys || !state.relayPool) return

  const agentName = state.agentName || 'sovereign-agent'
  const content: Record<string, string> = {
    name: agentName,
    about: (state.skill as any)?.description || `DVM agent (kind ${KIND})`,
    picture: `https://robohash.org/${encodeURIComponent(agentName)}`,
  }
  if (LIGHTNING_ADDRESS) {
    content.lud16 = LIGHTNING_ADDRESS
  }

  const event = signEventWithPow({
    kind: 0,
    tags: [],
    content: JSON.stringify(content),
  }, state.sovereignKeys.privkey, 20)

  const ok = await state.relayPool.publish(event)
  console.log(`[${label}] Published profile (Kind 0): ${ok ? 'ok' : 'failed'}`)
}

async function publishHandlerInfo(label: string) {
  if (!state.sovereignKeys || !state.relayPool) return

  const agentName = state.agentName || 'sovereign-agent'
  const content: Record<string, unknown> = {
    name: agentName,
    about: (state.skill as any)?.description || `DVM agent (kind ${KIND})`,
    pricing: { [String(KIND)]: SATS_PER_CHUNK * CHUNKS_PER_PAYMENT },
  }
  if (LIGHTNING_ADDRESS) {
    content.payment = { lightning_address: LIGHTNING_ADDRESS }
    content.lud16 = LIGHTNING_ADDRESS
  }

  const event = signEvent({
    kind: 31990,
    tags: [
      ['d', `${agentName}-${KIND}`],
      ['k', String(KIND)],
    ],
    content: JSON.stringify(content),
  }, state.sovereignKeys.privkey)

  const ok = await state.relayPool.publish(event)
  console.log(`[${label}] Published handler info (Kind 31990): ${ok ? 'ok' : 'failed'}`)
}

function subscribeNipXX(label: string) {
  if (!state.sovereignKeys || !state.relayPool) return

  state.relayPool.subscribe(
    { kinds: [25802], '#p': [state.sovereignKeys.pubkey] },
    (event: NostrEvent) => {
      handleAiPrompt(label, event).catch(e => {
        console.error(`[${label}] NIP-XX prompt error: ${e.message}`)
      })
    },
  )
  console.log(`[${label}] Subscribed to ai.prompt (Kind 25802)`)
}

let dvmSubscribed = false
function subscribeDvmRequests(label: string) {
  if (!state.sovereignKeys || !state.relayPool) return
  if (dvmSubscribed) return  // prevent double-subscribe (sovereign + platform both call this)
  dvmSubscribed = true

  // Subscribe to all DVM requests of our kind (broadcast + directed)
  state.relayPool.subscribe(
    { kinds: [KIND] },
    (event: NostrEvent) => {
      handleDvmRequest(label, event).catch(e => {
        console.error(`[${label}] DVM request error: ${e.message}`)
      })
    },
  )
  console.log(`[${label}] Subscribed to DVM requests (Kind ${KIND}) via relay`)
}

// --- Customer: subscribe to DVM results and auto-pay ---

let dvmResultSubscribed = false
function subscribeDvmResults(label: string) {
  if (!state.sovereignKeys || !state.relayPool) return
  if (dvmResultSubscribed) return
  dvmResultSubscribed = true

  // Subscribe to Kind 6xxx results directed to us (#p = our pubkey)
  const resultKind = KIND + 1000
  state.relayPool.subscribe(
    { kinds: [resultKind], '#p': [state.sovereignKeys.pubkey] },
    (event: NostrEvent) => {
      handleDvmResult(label, event).catch(e => {
        console.error(`[${label}] DVM result handler error: ${e.message}`)
      })
    },
  )
  console.log(`[${label}] Subscribed to DVM results (Kind ${resultKind}) via relay`)
}

async function handleDvmResult(label: string, event: NostrEvent) {
  if (!state.sovereignKeys || !state.relayPool) return
  if (event.pubkey === state.sovereignKeys.pubkey) return
  if (!markSeen(event.id)) return

  // Extract job reference, amount, and provider's Lightning Address
  const requestId = event.tags.find(t => t[0] === 'e')?.[1]
  const amountTag = event.tags.find(t => t[0] === 'amount')
  const amountMsats = Number(amountTag?.[1] || '0')
  const amountSats = Math.floor(amountMsats / 1000)
  const bolt11 = amountTag?.[2] || null  // NIP-90: ["amount", "<msats>", "<bolt11>"]
  // Providers may use lud16, lightning_address, or lud06 to declare their payment address
  const lightningAddress = event.tags.find(t => t[0] === 'lud16' || t[0] === 'lightning_address')?.[1]

  console.log(`[${label}] DVM result from ${event.pubkey.slice(0, 8)}: ${event.content.slice(0, 80)}...`)

  // Auto-pay if we have NWC
  let paid = false
  if (amountSats > 0 && state.nwcParsed) {
    try {
      if (bolt11) {
        // Preferred: pay bolt11 invoice directly from amount tag
        const { nwcPayInvoice } = await import('./nwc.js')
        const { preimage } = await nwcPayInvoice(state.nwcParsed, bolt11)
        console.log(`[${label}] Paid ${amountSats} sats via bolt11 (preimage: ${preimage.slice(0, 16)}...)`)
        paid = true
      } else if (lightningAddress) {
        // Fallback: pay via Lightning Address (lud16 / lightning_address tag)
        const { preimage } = await nwcPayLightningAddress(state.nwcParsed, lightningAddress, amountSats)
        console.log(`[${label}] Paid ${amountSats} sats → ${lightningAddress} (preimage: ${preimage.slice(0, 16)}...)`)
        paid = true
      } else {
        console.warn(`[${label}] Result requires ${amountSats} sats but provider has no bolt11 or Lightning Address`)
      }
    } catch (e) {
      console.error(`[${label}] Payment failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
    }
  } else if (amountSats === 0) {
    paid = true // free job
  } else if (amountSats > 0 && !state.nwcParsed) {
    console.warn(`[${label}] Result requires ${amountSats} sats but no NWC wallet configured`)
  }

  // Post-payment: publish completion events on Nostr
  if (paid && requestId) {
    try {
      // 1. Kind 7000 — status: success (tells relay the job is done)
      const successEvent = signEventWithPow({
        kind: 7000,
        tags: [
          ['p', event.pubkey],
          ['e', requestId],
          ['status', 'success'],
        ],
        content: '',
      }, state.sovereignKeys.privkey, 10)
      await state.relayPool.publish(successEvent)
      console.log(`[${label}] Published Kind 7000 status:success for ${requestId.slice(0, 8)}`)

      // 2. Kind 31117 — job review (per-job, visible on timeline)
      const reviewEvent = signEventWithPow({
        kind: 31117,
        tags: [
          ['d', requestId],
          ['e', requestId],
          ['p', event.pubkey],
          ['rating', '5'],
          ['role', 'customer'],
          ['k', String(KIND)],
        ],
        content: 'Auto-reviewed: job completed and paid',
      }, state.sovereignKeys.privkey, 10)
      await state.relayPool.publish(reviewEvent)
      console.log(`[${label}] Published Kind 31117 review for ${requestId.slice(0, 8)}`)

      // 3. Kind 30311 — peer endorsement (rolling reputation for provider)
      const endorsementEvent = signEventWithPow({
        kind: 30311,
        tags: [
          ['d', event.pubkey],
          ['p', event.pubkey],
          ['rating', '5'],
          ['k', String(KIND)],
        ],
        content: JSON.stringify({
          rating: 5,
          comment: 'Job completed and paid',
          trusted: true,
          context: { jobs_together: 1, kinds: [KIND], last_job_at: Math.floor(Date.now() / 1000) },
        }),
      }, state.sovereignKeys.privkey, 10)
      await state.relayPool.publish(endorsementEvent)
      console.log(`[${label}] Published Kind 30311 endorsement for ${event.pubkey.slice(0, 8)}`)
    } catch (e: any) {
      console.warn(`[${label}] Failed to publish post-payment events: ${e.message}`)
    }
  }

}

async function handleAiPrompt(label: string, event: NostrEvent) {
  if (!state.sovereignKeys || !state.relayPool || !state.processor) return
  if (!acquireSlot()) {
    await publishAiError(event.pubkey, event.id, 'RATE_LIMIT', 'Agent at capacity')
    return
  }

  try {
    const clientPubkey = event.pubkey
    const promptId = event.id

    // NIP-44 decrypt
    let content: any
    try {
      const decrypted = await nip44Decrypt(state.sovereignKeys.privkey, clientPubkey, event.content)
      content = JSON.parse(decrypted)
    } catch {
      await publishAiError(clientPubkey, promptId, 'INVALID_REQUEST', 'Failed to decrypt')
      return
    }

    const message = content.message || content.text || ''
    console.log(`[${label}] NIP-XX prompt from ${clientPubkey.slice(0, 8)}: "${message.slice(0, 60)}..."`)

    // Status: thinking
    await publishAiStatus(clientPubkey, promptId, 'thinking')

    // Process
    const { result } = await state.processor.generate({ input: message, params: content.params })
    console.log(`[${label}] NIP-XX response: ${result.length} chars`)

    // Build ai.response (Kind 25803)
    const responsePayload = JSON.stringify({
      text: result,
      usage: { input_tokens: message.length, output_tokens: result.length },
    })
    const encrypted = await nip44Encrypt(state.sovereignKeys.privkey, clientPubkey, responsePayload)

    const tags: string[][] = [
      ['p', clientPubkey],
      ['e', promptId],
    ]
    const sessionTag = event.tags.find(t => t[0] === 's')
    if (sessionTag) tags.push(sessionTag)

    const responseEvent = signEvent({
      kind: 25803,
      tags,
      content: encrypted,
    }, state.sovereignKeys.privkey)

    await state.relayPool!.publish(responseEvent)

    // Status: done
    await publishAiStatus(clientPubkey, promptId, 'done')
    console.log(`[${label}] Published ai.response (Kind 25803)`)
  } finally {
    releaseSlot()
  }
}

async function handleDvmRequest(label: string, event: NostrEvent) {
  if (!state.sovereignKeys || !state.relayPool || !state.processor) return

  // Skip own events
  if (event.pubkey === state.sovereignKeys.pubkey) return

  // Dedup: skip already-seen events
  if (!markSeen(event.id)) return

  if (!acquireSlot()) return

  try {
    // Step 1: p-tag filter — if request is directed (has p tags) but not to us, skip
    const pTags = event.tags.filter(t => t[0] === 'p').map(t => t[1])
    if (pTags.length > 0 && !pTags.includes(state.sovereignKeys.pubkey)) {
      console.log(`[${label}] DVM request ${event.id.slice(0, 8)} directed to another agent, skipping`)
      return
    }

    // Step 2: handle NIP-44 encrypted requests
    const isEncrypted = event.tags.some(t => t[0] === 'encrypted')
    let rawInput: string
    if (isEncrypted) {
      try {
        rawInput = await nip44Decrypt(state.sovereignKeys.privkey, event.pubkey, event.content)
        console.log(`[${label}] DVM request ${event.id.slice(0, 8)} decrypted successfully`)
      } catch {
        console.log(`[${label}] DVM request ${event.id.slice(0, 8)} decryption failed (not for us), skipping`)
        return
      }
    } else {
      rawInput = ''
    }

    // Parse DVM request: for encrypted jobs, decrypted content is a JSON array of tags
    // Per NIP-90: [["i","actual input","text"],["param","model","..."],...]
    let effectiveTags: string[][] = event.tags
    if (isEncrypted) {
      try {
        const parsed = JSON.parse(rawInput)
        if (Array.isArray(parsed)) effectiveTags = parsed
      } catch { /* rawInput is plain text — fall through, handled below */ }
    }
    const inputTag = effectiveTags.find(t => t[0] === 'i')
    // For encrypted plain-text fallback: rawInput itself is the input
    const input = inputTag?.[1] || (isEncrypted ? rawInput : '')
    const requestedModel = effectiveTags.find(t => t[0] === 'param' && t[1] === 'model')?.[2]
    if (!input) {
      console.warn(`[${label}] DVM request ${event.id.slice(0, 8)} has no input`)
      return
    }

    // Reject jobs with bid below minimum price
    const jobBidMsats = Number(event.tags.find(t => t[0] === 'bid')?.[1] || '0')
    if (jobBidMsats > 0 && jobBidMsats < MIN_BID_SATS * 1000) {
      console.log(`[${label}] DVM request ${event.id.slice(0, 8)} bid ${jobBidMsats} msats below minimum ${MIN_BID_SATS * 1000} msats, skipping`)
      return
    }

    console.log(`[${label}] DVM request from ${event.pubkey.slice(0, 8)}: "${input.slice(0, 60)}..."`)

    // Send feedback (Kind 7000)
    const feedbackEvent = signEvent({
      kind: 7000,
      tags: [
        ['p', event.pubkey],
        ['e', event.id],
        ['status', 'processing'],
      ],
      content: '',
    }, state.sovereignKeys.privkey)
    await state.relayPool.publish(feedbackEvent)

    // Process (with optional pipeline: delegate sub-task first)
    let result: string
    let actualModel: string
    if (SUB_KIND) {
      console.log(`[${label}] Pipeline: delegating to kind ${SUB_KIND}...`)
      try {
        const subResult = await delegateNostr(label, SUB_KIND, input, SUB_BID, SUB_PROVIDER)
        console.log(`[${label}] Sub-task returned ${subResult.length} chars`)
        ;({ result, model: actualModel } = await state.processor.generate({ input: subResult, model: requestedModel }))
      } catch (e: any) {
        console.error(`[${label}] Sub-task failed: ${e.message}, using original input`)
        ;({ result, model: actualModel } = await state.processor.generate({ input, model: requestedModel }))
      }
    } else {
      ;({ result, model: actualModel } = await state.processor.generate({ input, model: requestedModel }))
    }
    console.log(`[${label}] DVM result: ${result.length} chars`)

    // Send result (Kind 6xxx = request kind + 1000)
    const resultKind = KIND + 1000
    // Prefer the bid the customer declared in the job; fall back to local fixed price.
    // bid tag is in the outer (unencrypted) event tags per NIP-90.
    const bidMsats = Number(event.tags.find(t => t[0] === 'bid')?.[1] || '0')
    const fixedPriceMsats = SATS_PER_CHUNK * CHUNKS_PER_PAYMENT * 1000
    const amountMsats = bidMsats > 0 ? bidMsats : fixedPriceMsats
    let amountTag: string[]
    if (amountMsats > 0 && state.nwcParsed) {
      try {
        const { bolt11 } = await nwcMakeInvoice(state.nwcParsed, amountMsats, `DVM job ${event.id.slice(0, 8)}`)
        amountTag = ['amount', String(amountMsats), bolt11]
      } catch (e) {
        console.warn(`[${label}] Failed to generate invoice via NWC, falling back to amount-only:`, e)
        amountTag = ['amount', String(amountMsats)]
      }
    } else {
      amountTag = ['amount', String(amountMsats)]
    }
    const resultTags: string[][] = [
      ['p', event.pubkey],
      ['e', event.id],
      ['request', JSON.stringify(event)],
      amountTag,
    ]
    if (LIGHTNING_ADDRESS) {
      resultTags.push(['lightning_address', LIGHTNING_ADDRESS])
    }
    if (actualModel) {
      resultTags.push(['model', actualModel])
    }
    const resultEvent = signEvent({
      kind: resultKind,
      tags: resultTags,
      content: result,
    }, state.sovereignKeys.privkey)

    await state.relayPool.publish(resultEvent)
    console.log(`[${label}] Published DVM result (Kind ${resultKind}) via relay`)

    // Publish reputation endorsement (Kind 30311) for customer
    try {
      const endorsementEvent = signEventWithPow({
        kind: 30311,
        tags: [
          ['d', event.pubkey],
          ['p', event.pubkey],
          ['rating', '5'],
          ['k', String(KIND)],
        ],
        content: JSON.stringify({
          rating: 5,
          context: { jobs_together: 1, kinds: [KIND], last_job_at: Math.floor(Date.now() / 1000) },
        }),
      }, state.sovereignKeys.privkey, 10)
      await state.relayPool.publish(endorsementEvent)
      console.log(`[${label}] Published endorsement (Kind 30311) for ${event.pubkey.slice(0, 8)}`)
    } catch (e: any) {
      console.warn(`[${label}] Failed to publish endorsement: ${e.message}`)
    }
  } finally {
    releaseSlot()
  }
}

async function publishAiStatus(clientPubkey: string, promptId: string, status: string) {
  if (!state.sovereignKeys || !state.relayPool) return

  const payload = JSON.stringify({ state: status })
  const encrypted = await nip44Encrypt(state.sovereignKeys.privkey, clientPubkey, payload)

  const event = signEvent({
    kind: 25800,
    tags: [['p', clientPubkey], ['e', promptId]],
    content: encrypted,
  }, state.sovereignKeys.privkey)

  await state.relayPool.publish(event).catch(() => {})
}

async function publishAiError(clientPubkey: string, promptId: string, code: string, message: string) {
  if (!state.sovereignKeys || !state.relayPool) return

  const payload = JSON.stringify({ code, message })
  const encrypted = await nip44Encrypt(state.sovereignKeys.privkey, clientPubkey, payload)

  const event = signEvent({
    kind: 25805,
    tags: [['p', clientPubkey], ['e', promptId]],
    content: encrypted,
  }, state.sovereignKeys.privkey)

  await state.relayPool.publish(event).catch(() => {})
}

function startNostrHeartbeat(
  label: string,
  keys: SovereignKeys,
  pool: RelayPool,
  opts?: {
    pricing?: Record<string, number>
    p2pStatsFn?: () => { sessions: number; earned_sats: number; active: boolean }
  },
): () => void {
  async function publishHeartbeat() {
    const tags: string[][] = [
      ['d', keys.pubkey],
      ['status', 'online'],
      ['capacity', String(getAvailableCapacity())],
      ['kinds', String(KIND)],
    ]

    // Add pricing tag (format: "5100:50,5200:100")
    if (opts?.pricing && Object.keys(opts.pricing).length > 0) {
      tags.push(['price', Object.entries(opts.pricing).map(([k, v]) => `${k}:${v}`).join(',')])
    }

    // Add p2p_stats tag (JSON)
    if (opts?.p2pStatsFn) {
      const stats = opts.p2pStatsFn()
      tags.push(['p2p_stats', JSON.stringify(stats)])
    }

    const event = signEvent({
      kind: 30333,
      tags,
      content: '',
    }, keys.privkey)

    const ok = await pool.publish(event)
    if (ok) console.log(`[${label}] Heartbeat published to relay`)
  }

  publishHeartbeat()
  const timer = setInterval(publishHeartbeat, 60_000)
  return () => clearInterval(timer)
}

/** @deprecated Use startNostrHeartbeat. Kept for backward compat. */
function startSovereignHeartbeat(label: string) {
  if (!state.sovereignKeys || !state.relayPool) return
  startNostrHeartbeat(label, state.sovereignKeys, state.relayPool)
}

// --- Sub-task delegation ---

/**
 * Delegate a sub-task via Nostr relay. Publishes Kind 5xxx request,
 * then subscribes for Kind 6xxx result (max 120s timeout).
 */
async function delegateNostr(label: string, kind: number, input: string, bidSats: number, provider?: string): Promise<string> {
  if (!state.sovereignKeys || !state.relayPool) {
    throw new Error('No Nostr keys or relay pool — cannot delegate sub-task')
  }

  const tags: string[][] = [
    ['i', input, 'text'],
    ['bid', String(bidSats * 1000)],  // msats
  ]
  if (provider) {
    tags.push(['p', provider])
  }

  const requestEvent = signEventWithPow({
    kind,
    tags,
    content: '',
  }, state.sovereignKeys.privkey, 10)

  await state.relayPool.publish(requestEvent)
  console.log(`[${label}] Published sub-task (Kind ${kind}, id ${requestEvent.id.slice(0, 8)})`)

  // Subscribe for result (Kind = request kind + 1000) referencing our request
  const resultKind = kind + 1000
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      sub.close()
      reject(new Error(`Sub-task ${requestEvent.id.slice(0, 8)} timed out after 120s`))
    }, 120_000)

    const sub = state.relayPool!.subscribe(
      { kinds: [resultKind], '#e': [requestEvent.id] },
      (event: NostrEvent) => {
        clearTimeout(timeout)
        sub.close()
        console.log(`[${label}] Sub-task result from ${event.pubkey.slice(0, 8)}: ${event.content.length} chars`)
        resolve(event.content)
      },
    )
  })
}

// --- 4. P2P Swarm Listener ---

// --- Session state ---

interface SessionState {
  socket: any
  peerId: string
  sessionId: string
  satsPerMinute: number
  paymentMethod: 'invoice'
  totalEarned: number
  startedAt: number
  lastPaidAt: number
  billingTimer: ReturnType<typeof setInterval> | null
  timeoutTimer: ReturnType<typeof setTimeout> | null
  customerPubkey?: string
  proxyMode: boolean    // HTTP backend — use raw TCP pipe instead of JSON messages
  proxyStarted: boolean // true after TCP pipe is established
  pendingPaymentHash?: string  // expected payment_hash for current session_tick; verified on ack
}

/**
 * Inject think:false into Ollama chat/generate requests.
 * Suppresses reasoning tokens on models like qwen3 that enable thinking by default.
 */
function injectThinkFalse(rawBytes: Buffer): Buffer {
  const raw = rawBytes.toString()
  const sep = raw.indexOf('\r\n\r\n')
  if (sep === -1) return rawBytes
  const header = raw.slice(0, sep + 4)
  const body = raw.slice(sep + 4)
  if (!header.includes('POST') || (!header.includes('/api/generate') && !header.includes('/api/chat'))) return rawBytes
  try {
    const json = JSON.parse(body)
    if (json.think !== undefined) return rawBytes
    json.think = false
    const newBody = JSON.stringify(json)
    const newHeader = header.replace(/Content-Length:\s*\d+/i, `Content-Length: ${Buffer.byteLength(newBody)}`)
    return Buffer.from(newHeader + newBody)
  } catch { return rawBytes }
}

/**
 * After session payment, switch this socket to a raw TCP pipe to the HTTP backend.
 * The customer then has direct HTTP API access (Ollama, SD-WebUI, etc.) with true streaming.
 * This removes SwarmNode's JSON framing from the socket and replaces it with a bidirectional pipe.
 */
function startTcpProxy(session: SessionState, node: SwarmNode, processorUrl: string, label: string) {
  let addr: { host: string; port: number }
  try {
    const u = new URL(processorUrl)
    addr = { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) }
  } catch {
    console.error(`[${label}] Session ${session.sessionId}: invalid backend URL ${processorUrl}`)
    endSession(node, session, label)
    return
  }

  session.proxyStarted = true
  const socket = session.socket

  const backend = createConnection(addr.port, addr.host)
  backend.setKeepAlive(true)

  // Remove SwarmNode's newline-delimited JSON listener so raw HTTP bytes flow through
  socket.removeAllListeners('data')
  socket.on('data', (chunk: Buffer) => backend.write(injectThinkFalse(chunk)))
  backend.pipe(socket)

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return; cleaned = true
    try { socket.destroy() } catch {}
    try { backend.destroy() } catch {}
    endSession(node, session, label)
  }

  socket.on('close', cleanup)
  socket.on('error', () => cleanup())
  backend.on('close', cleanup)
  backend.on('error', (e: Error) => {
    console.log(`[${label}] Session ${session.sessionId}: backend error: ${e.message}`)
    cleanup()
  })

  console.log(`[${label}] Session ${session.sessionId}: TCP proxy → ${addr.host}:${addr.port}`)
}

const activeSessions = new Map<string, SessionState>()

// Dedup: track recently seen DVM request event IDs (prevent double-processing from relay + inbox)
const seenEventIds = new Set<string>()
const MAX_SEEN = 500
function markSeen(eventId: string): boolean {
  if (seenEventIds.has(eventId)) return false
  seenEventIds.add(eventId)
  if (seenEventIds.size > MAX_SEEN) {
    const first = seenEventIds.values().next().value
    if (first) seenEventIds.delete(first)
  }
  return true
}

/** Verify Lightning payment preimage: SHA256(preimage_hex) should equal payment_hash_hex */
function verifyPreimage(preimageHex: string, paymentHashHex: string): boolean {
  try {
    const preimageBytes = Buffer.from(preimageHex, 'hex')
    const computed = createHash('sha256').update(preimageBytes).digest('hex')
    return computed === paymentHashHex.toLowerCase()
  } catch {
    return false
  }
}

/** Send a billing tick to the customer — generate Lightning invoice via NWC make_invoice. */
async function sendBillingTick(node: SwarmNode, session: SessionState, amount: number, label: string) {
  const tickId = randomBytes(4).toString('hex')
  try {
    if (!state.nwcParsed) {
      throw new Error('NWC wallet not configured — cannot generate invoice')
    }
    const result = await nwcMakeInvoice(state.nwcParsed, amount * 1000, `2020117 session ${session.sessionId}`)
    session.pendingPaymentHash = result.payment_hash
    node.send(session.socket, {
      type: 'session_tick',
      id: tickId,
      session_id: session.sessionId,
      bolt11: result.bolt11,
      amount,
    })
    console.log(`[${label}] Session ${session.sessionId}: sent invoice (${amount} sats)`)
  } catch (e: any) {
    console.log(`[${label}] Session ${session.sessionId}: invoice error (${e.message}) — ending session`)
    endSession(node, session, label)
  }
}

// Backend WebSocket connections for WS tunnel (keyed by ws_id)
const backendWebSockets = new Map<string, { ws: WebSocket; peerId: string }>()

async function startSwarmListener(label: string) {
  const node = new SwarmNode()
  state.swarmNode = node

  const topic = topicFromKind(KIND)

  console.log(`[${label}] Joining swarm topic for kind ${KIND}`)
  await node.listen(topic)
  console.log(`[${label}] P2P listening for customers...`)

  node.on('message', async (msg: SwarmMessage, socket: any, peerId: string) => {
    const tag = peerId.slice(0, 8)

    if (msg.type === 'skill_request') {
      const satsPerMinute =
        (state.skill?.pricing as any)?.sats_per_minute
        || Number(process.env.SATS_PER_MINUTE)
        || 10
      // Always include runtime pricing, even without a skill file
      const skillWithPricing = state.skill
        ? { ...state.skill, pricing: { ...(state.skill.pricing as any || {}), sats_per_minute: satsPerMinute } }
        : { pricing: { sats_per_minute: satsPerMinute }, payment_methods: ['invoice'] }
      node.send(socket, { type: 'skill_response', id: msg.id, skill: skillWithPricing })
      return
    }

    // --- Session protocol ---

    if (msg.type === 'session_start') {
      const processorUrl = process.env.PROCESSOR || ''
      const proxyMode = processorUrl.startsWith('http://') || processorUrl.startsWith('https://')

      if (!proxyMode && !state.nwcParsed) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Provider payment not configured (need --nwc)' })
        return
      }
      const paymentMethod: 'invoice' = 'invoice'

      const satsPerMinute =
        (state.skill?.pricing as any)?.sats_per_minute
        || Number(process.env.SATS_PER_MINUTE)
        || msg.sats_per_minute
        || 10

      const BILLING_INTERVAL_MIN = 1
      const billingAmount = satsPerMinute * BILLING_INTERVAL_MIN

      const sessionId = randomBytes(8).toString('hex')
      const modeLabel = proxyMode ? `proxy→${processorUrl}` : `${satsPerMinute} sats/min`
      console.log(`[${label}] Session ${sessionId} from ${tag}: ${modeLabel}`)

      const session: SessionState = {
        socket,
        peerId,
        sessionId,
        satsPerMinute,
        paymentMethod,
        totalEarned: 0,
        startedAt: Date.now(),
        lastPaidAt: Date.now(),
        billingTimer: null,
        timeoutTimer: null,
        customerPubkey: msg.pubkey || undefined,
        proxyMode,
        proxyStarted: false,
      }

      activeSessions.set(sessionId, session)

      node.send(socket, {
        type: 'session_ack',
        id: msg.id,
        session_id: sessionId,
        sats_per_minute: satsPerMinute,
        payment_method: paymentMethod,
        pubkey: state.sovereignKeys?.pubkey,
        proxy_mode: proxyMode,
      })

      if (proxyMode) {
        if (billingAmount <= 0 || !state.nwcParsed) {
          // Free proxy — open TCP pipe immediately
          startTcpProxy(session, node, processorUrl, label)
        } else {
          // Paid proxy — one-time session fee, TCP pipe starts on payment (session_tick_ack)
          await sendBillingTick(node, session, billingAmount, label)
        }
      } else {
        // Per-minute billing for structured request/result sessions
        await sendBillingTick(node, session, billingAmount, label)
        session.billingTimer = setInterval(() => {
          sendBillingTick(node, session, billingAmount, label)
        }, BILLING_INTERVAL_MIN * 60_000)
      }

      return
    }

    // Customer sent payment (Lightning preimage)
    if (msg.type === 'session_tick_ack') {
      const session = activeSessions.get(msg.session_id || '')
      if (!session) return

      if (msg.preimage) {
        // Verify preimage: SHA256(preimage) must equal the invoice's payment_hash.
        // If payment_hash is missing (bolt11 decode failed), reject — fail secure.
        if (!session.pendingPaymentHash) {
          console.log(`[${label}] Session ${session.sessionId}: cannot verify payment (no payment_hash) — ending session`)
          node.send(session.socket, { type: 'error', id: msg.id, message: 'Provider cannot verify payment' })
          endSession(node, session, label)
          return
        }
        if (!verifyPreimage(msg.preimage, session.pendingPaymentHash)) {
          console.log(`[${label}] Session ${session.sessionId}: invalid preimage — ending session`)
          node.send(session.socket, { type: 'error', id: msg.id, message: 'Invalid payment preimage' })
          endSession(node, session, label)
          return
        }
        session.pendingPaymentHash = undefined
        const amount = msg.amount || 0
        session.totalEarned += amount
        session.lastPaidAt = Date.now()
        console.log(`[${label}] Session ${session.sessionId}: payment verified (+${amount}, total: ${session.totalEarned} sats)`)
      } else {
        // No preimage provided — reject
        console.log(`[${label}] Session ${session.sessionId}: session_tick_ack missing preimage — ending session`)
        node.send(session.socket, { type: 'error', id: msg.id, message: 'Payment preimage required' })
        endSession(node, session, label)
        return
      }

      // Proxy mode: switch to raw TCP pipe after first payment confirmed
      if (session.proxyMode && !session.proxyStarted) {
        startTcpProxy(session, node, process.env.PROCESSOR || '', label)
      }

      return
    }

    if (msg.type === 'session_end') {
      const session = activeSessions.get(msg.session_id || '')
      if (!session) return
      endSession(node, session, label)
      return
    }

    if (msg.type === 'http_request') {
      const session = findSessionBySocket(socket)
      if (!session) {
        node.send(socket, { type: 'error', id: msg.id, message: 'No active session' })
        return
      }

      const processorUrl = process.env.PROCESSOR
      if (!processorUrl || (!processorUrl.startsWith('http://') && !processorUrl.startsWith('https://'))) {
        node.send(socket, {
          type: 'http_response',
          id: msg.id,
          status: 502,
          body: JSON.stringify({ error: 'Provider has no HTTP backend configured' }),
        })
        return
      }

      try {
        const targetUrl = new URL(msg.path || '/', processorUrl).toString()
        const fetchHeaders: Record<string, string> = { ...(msg.headers || {}) }
        delete fetchHeaders['host']

        const res = await fetch(targetUrl, {
          method: msg.method || 'GET',
          headers: fetchHeaders,
          body: msg.method !== 'GET' && msg.method !== 'HEAD' ? msg.body : undefined,
        })

        const resHeaders: Record<string, string> = {}
        res.headers.forEach((v, k) => { resHeaders[k] = v })

        // Detect binary content — read as ArrayBuffer to avoid text() mangling
        const ct = (res.headers.get('content-type') || '').toLowerCase()
        const isText = ct.startsWith('text/') || ct.includes('json') || ct.includes('javascript')
          || ct.includes('xml') || ct.includes('svg') || ct.includes('css')
          || ct.includes('html') || ct === ''
        const bodyEncoding: 'base64' | undefined = isText ? undefined : 'base64'

        let resBody: string
        if (isText) {
          resBody = await res.text()
        } else {
          const buf = Buffer.from(await res.arrayBuffer())
          resBody = buf.toString('base64')
        }

        // Chunk large responses to avoid swarm transport truncation
        const CHUNK_SIZE = 48_000 // ~48KB per chunk (safe margin under 64KB NOISE frame)
        if (resBody.length > CHUNK_SIZE) {
          const chunks: string[] = []
          for (let i = 0; i < resBody.length; i += CHUNK_SIZE) {
            chunks.push(resBody.slice(i, i + CHUNK_SIZE))
          }
          for (let i = 0; i < chunks.length; i++) {
            node.send(socket, {
              type: 'http_response',
              id: msg.id,
              status: i === 0 ? res.status : undefined,
              headers: i === 0 ? resHeaders : undefined,
              body: chunks[i],
              body_encoding: i === 0 ? bodyEncoding : undefined,
              chunk_index: i,
              chunk_total: chunks.length,
            })
          }
        } else {
          node.send(socket, {
            type: 'http_response',
            id: msg.id,
            status: res.status,
            headers: resHeaders,
            body: resBody,
            body_encoding: bodyEncoding,
          })
        }
      } catch (e: any) {
        node.send(socket, {
          type: 'http_response',
          id: msg.id,
          status: 502,
          body: JSON.stringify({ error: e.message }),
        })
      }
      return
    }

    // --- WebSocket tunnel ---

    if (msg.type === 'ws_open') {
      const session = findSessionBySocket(socket)
      if (!session) {
        node.send(socket, { type: 'error', id: msg.id, message: 'No active session' })
        return
      }

      const processorUrl = process.env.PROCESSOR
      if (!processorUrl || (!processorUrl.startsWith('http://') && !processorUrl.startsWith('https://'))) {
        node.send(socket, { type: 'ws_open', id: msg.id, ws_id: msg.ws_id, message: 'No HTTP backend configured' })
        return
      }

      const wsId = msg.ws_id!
      const wsPath = msg.ws_path || '/'
      const backendWsUrl = processorUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '') + wsPath

      console.log(`[${label}] WS ${wsId}: opening ${backendWsUrl}`)

      try {
        const backendWs = new WebSocket(backendWsUrl, msg.ws_protocols || [])
        backendWebSockets.set(wsId, { ws: backendWs, peerId })

        backendWs.on('open', () => {
          console.log(`[${label}] WS ${wsId}: backend connected`)
        })

        backendWs.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          if (isBinary) {
            node.send(socket, { type: 'ws_message', id: wsId, ws_id: wsId, data: buf.toString('base64'), ws_frame_type: 'binary' })
          } else {
            node.send(socket, { type: 'ws_message', id: wsId, ws_id: wsId, data: buf.toString('utf-8'), ws_frame_type: 'text' })
          }
        })

        backendWs.on('close', (code: number, reason: Buffer) => {
          console.log(`[${label}] WS ${wsId}: backend closed (code=${code})`)
          backendWebSockets.delete(wsId)
          node.send(socket, { type: 'ws_close', id: wsId, ws_id: wsId, ws_code: code, ws_reason: reason.toString() })
        })

        backendWs.on('error', (err: Error) => {
          console.error(`[${label}] WS ${wsId}: backend error: ${err.message}`)
          backendWebSockets.delete(wsId)
          node.send(socket, { type: 'ws_close', id: wsId, ws_id: wsId, ws_code: 1011, ws_reason: 'Backend WebSocket error' })
        })
      } catch (e: any) {
        node.send(socket, { type: 'ws_open', id: msg.id, ws_id: wsId, message: e.message })
      }
      return
    }

    if (msg.type === 'ws_message') {
      const entry = backendWebSockets.get(msg.ws_id || '')
      if (!entry || entry.ws.readyState !== WebSocket.OPEN) return
      try {
        if (msg.ws_frame_type === 'binary') {
          entry.ws.send(Buffer.from(msg.data || '', 'base64'))
        } else {
          entry.ws.send(msg.data || '')
        }
      } catch (e: any) {
        console.error(`[${label}] WS ${msg.ws_id}: send failed: ${e.message}`)
      }
      return
    }

    if (msg.type === 'ws_close') {
      const entry = backendWebSockets.get(msg.ws_id || '')
      if (entry) {
        console.log(`[${label}] WS ${msg.ws_id}: closing backend`)
        try { entry.ws.close(msg.ws_code || 1000, msg.ws_reason || '') } catch {}
        backendWebSockets.delete(msg.ws_id || '')
      }
      return
    }

    // Session-scoped request (no payment negotiation — session pays per-minute)
    if (msg.type === 'request' && msg.session_id) {
      const session = activeSessions.get(msg.session_id)
      if (!session) {
        node.send(socket, { type: 'error', id: msg.id, message: 'Unknown session' })
        return
      }
      console.log(`[${label}] Session job ${msg.id}: "${(msg.input || '').slice(0, 60)}..."`)
      try {
        const { result } = await state.processor!.generate({ input: msg.input || '', params: msg.params })
        node.send(socket, { type: 'result', id: msg.id, output: result })
        console.log(`[${label}] Session job ${msg.id}: ${result.length} chars`)
      } catch (e: any) {
        node.send(socket, { type: 'error', id: msg.id, message: e.message })
      }
      return
    }

  })

  // Handle customer disconnect
  node.on('peer-leave', (peerId: string) => {
    const tag = peerId.slice(0, 8)

    // Find and end all sessions for this peer
    for (const [sessionId, session] of activeSessions) {
      if (session.peerId === peerId) {
        console.log(`[${label}] Peer ${tag} disconnected — ending session ${sessionId} (${session.totalEarned} sats earned)`)
        endSession(node, session, label)
      }
    }

    // Clean up backend WebSockets for this peer
    for (const [wsId, entry] of backendWebSockets) {
      if (entry.peerId === peerId) {
        try { entry.ws.close(1001, 'Peer disconnected') } catch {}
        backendWebSockets.delete(wsId)
      }
    }
  })
}

// --- Session helpers ---

function findSessionBySocket(socket: any): SessionState | undefined {
  for (const session of activeSessions.values()) {
    if (session.socket === socket) return session
  }
  return undefined
}

function endSession(node: SwarmNode, session: SessionState, label: string) {
  const durationS = Math.round((Date.now() - session.startedAt) / 1000)

  // Stop billing timer
  if (session.billingTimer) {
    clearInterval(session.billingTimer)
    session.billingTimer = null
  }

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer)
    session.timeoutTimer = null
  }

  // Close all backend WebSockets for this peer
  for (const [wsId, entry] of backendWebSockets) {
    if (entry.peerId === session.peerId) {
      try { entry.ws.close(1001, 'Session ended') } catch {}
      backendWebSockets.delete(wsId)
    }
  }

  try {
    node.send(session.socket, {
      type: 'session_end',
      id: session.sessionId,
      session_id: session.sessionId,
      total_sats: session.totalEarned,
      duration_s: durationS,
    })
  } catch {
    // Socket may already be closed (peer disconnect)
  }

  console.log(`[${label}] Session ${session.sessionId} ended: ${session.totalEarned} sats, ${durationS}s`)

  // Publish Kind 30311 endorsement for customer (best-effort)
  if (state.sovereignKeys && state.relayPool && session.customerPubkey) {
    try {
      const endorsement = signEventWithPow({
        kind: 30311,
        tags: [
          ['d', session.customerPubkey],
          ['p', session.customerPubkey],
          ['rating', '5'],
          ['k', String(KIND)],
        ],
        content: JSON.stringify({
          rating: 5,
          context: {
            session_duration_s: durationS,
            total_sats: session.totalEarned,
            kinds: [KIND],
            last_job_at: Math.floor(Date.now() / 1000),
          },
        }),
      }, state.sovereignKeys.privkey, 10)
      state.relayPool.publish(endorsement).catch(() => {})
      console.log(`[${label}] Published endorsement for customer ${session.customerPubkey.slice(0, 8)}`)
    } catch {}
  }

  // Update P2P lifetime counters
  state.p2pSessionsCompleted++
  state.p2pTotalEarnedSats += session.totalEarned

  // Session stats are included in the next Kind 30333 heartbeat automatically

  activeSessions.delete(session.sessionId)
}

// --- 5. Graceful shutdown ---

function setupShutdown(label: string) {
  const shutdown = async () => {
    if (state.shuttingDown) return
    state.shuttingDown = true
    console.log(`\n[${label}] Shutting down...`)

    // Stop heartbeat
    if (state.stopHeartbeat) state.stopHeartbeat()

    // Wait for active jobs to finish (max 10s)
    if (state.activeJobs > 0) {
      console.log(`[${label}] Waiting for ${state.activeJobs} active job(s)...`)
      const deadline = Date.now() + 10_000
      while (state.activeJobs > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500))
      }
      if (state.activeJobs > 0) {
        console.warn(`[${label}] ${state.activeJobs} job(s) still running, forcing exit`)
      }
    }

    // Destroy swarm
    if (state.swarmNode) {
      await state.swarmNode.destroy()
    }

    // Close relay pool (sovereign mode)
    if (state.relayPool) {
      await state.relayPool.close()
    }

    console.log(`[${label}] Goodbye`)
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// --- Entry point ---

main().catch(err => {
  console.error('[agent] Fatal:', err)
  process.exit(1)
})
