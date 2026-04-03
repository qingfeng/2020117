#!/usr/bin/env node
/**
 * Quick test: send a Kind 5100 DVM job with bid=0 to relay,
 * target ollama_analyst, wait for Kind 7000 + Kind 6100 response.
 */
import WebSocket from 'ws'
globalThis.WebSocket = WebSocket

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Relay } from 'nostr-tools/relay'
import { bytesToHex } from 'nostr-tools/utils'
import { minePow } from 'nostr-tools/nip13'

const RELAY = 'wss://relay.2020117.xyz'
const OLLAMA_ANALYST_PUBKEY = 'ebfa498817513f4696b1bbda67d2a42d011e8cd42369d59ebf984788612abf05'
const POW_DIFFICULTY = 10
const TIMEOUT_MS = 120_000  // 2 min

const sk = generateSecretKey()
const pubkey = getPublicKey(sk)
console.log(`\n[test] Temp identity: ${bytesToHex(sk).slice(0, 8)}... pubkey: ${pubkey.slice(0, 16)}...`)

console.log(`[test] Connecting to ${RELAY}...`)
const relay = await Relay.connect(RELAY)
console.log(`[test] Connected.`)

const prompt = 'What is 2+2? Reply in one short sentence.'

// Build Kind 5100 with bid=0, p-tagged to ollama_analyst
console.log(`[test] Mining POW ${POW_DIFFICULTY}...`)
const t0 = Date.now()
const unsigned = minePow({
  kind: 5100,
  pubkey,
  content: '',
  tags: [
    ['i', prompt, 'text'],
    ['bid', '0'],                         // 0 msats bid
    ['p', OLLAMA_ANALYST_PUBKEY],         // direct to ollama_analyst
    ['relays', RELAY],
  ],
  created_at: Math.floor(Date.now() / 1000),
}, POW_DIFFICULTY)
const event = finalizeEvent(unsigned, sk)
console.log(`[test] POW done in ${Date.now() - t0}ms. Event: ${event.id.slice(0, 16)}...`)

// Subscribe for responses to our event
let resolved = false
const done = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout — no response in 2min')), TIMEOUT_MS)

  relay.subscribe(
    [
      { kinds: [7000, 6100], '#e': [event.id], since: Math.floor(Date.now() / 1000) - 5 },
    ],
    {
      onevent(ev) {
        if (resolved) return
        if (ev.kind === 7000) {
          const status = ev.tags.find(t => t[0] === 'status')?.[1]
          console.log(`\n[test] ← Kind 7000 (feedback) from ${ev.pubkey.slice(0,12)}... status="${status}"`)
          if (ev.content) console.log(`  content: ${ev.content.slice(0, 200)}`)
        }
        if (ev.kind === 6100) {
          resolved = true
          clearTimeout(timeout)
          console.log(`\n[test] ← Kind 6100 (result!) from ${ev.pubkey.slice(0,12)}...`)
          console.log(`  content: ${ev.content.slice(0, 500)}`)
          resolve(ev)
        }
      },
    }
  )
})

// Publish the job
console.log(`[test] Publishing Kind 5100 (bid=0)...`)
await relay.publish(event)
console.log(`[test] Published. Waiting for ollama_analyst to respond...\n`)

try {
  await done
  console.log('\n[test] ✅ SUCCESS — ollama_analyst responded to 0-bid request!')
} catch (e) {
  console.error(`\n[test] ❌ ${e.message}`)
} finally {
  relay.close()
  process.exit(0)
}
