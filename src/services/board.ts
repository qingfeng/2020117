import { eq, and, sql } from 'drizzle-orm'
import type { Database } from '../db'
import type { Bindings } from '../types'
import { users, dvmJobs } from '../db/schema'
import { decryptNostrPrivkey, buildSignedEvent } from './nostr'
import { nip04Encrypt, nip04Decrypt, decryptNwcUri, parseNwcUri, nwcPayInvoice, resolveAndPayLightningAddress } from './nwc'
import { fetchEventsFromRelay } from './nostr-community'
import { buildJobRequestEvent } from './dvm'
import { generateId } from '../lib/utils'

// --- Intent parsing ---

interface ParsedIntent {
  kind: number
  label: string
}

function parseIntent(text: string): ParsedIntent {
  const lower = text.toLowerCase()

  if (/\b(translate|翻译)\b/.test(lower)) {
    return { kind: 5302, label: 'translation' }
  }
  if (/\b(summarize|summary|总结|摘要)\b/.test(lower)) {
    return { kind: 5303, label: 'summarization' }
  }
  if (/\b(image|draw|picture|画|图|生成图)\b/.test(lower)) {
    return { kind: 5200, label: 'text-to-image' }
  }
  return { kind: 5100, label: 'text generation' }
}

// --- Bid amount parsing ---

function parseBidSats(text: string, maxSats: number): number {
  const patterns = [
    /(\d+)\s*sats?\b/i,    // "100sats", "100 sats", "50sat"
    /sats?\s*:\s*(\d+)/i,  // "sat:100", "sats:50"
  ]
  for (const pat of patterns) {
    const m = text.match(pat)
    if (m) {
      const val = parseInt(m[1])
      if (val > 0) return Math.min(val, maxSats)
    }
  }
  return 0
}

// --- Confirmation message ---

function confirmationMessage(label: string, bidSats: number): string {
  const msgs: Record<string, string> = {
    'translation': 'Got it! Working on translation...',
    'summarization': 'Got it! Working on summarization...',
    'text-to-image': 'Got it! Generating image...',
    'text generation': 'Got it! Processing your request...',
  }
  const base = msgs[label] || 'Got it! Processing...'
  if (bidSats > 0) return `${base} (${bidSats} sats bid attached)`
  return base
}

// --- Poll board inbox: receive messages, create DVM jobs ---

export async function pollBoardInbox(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return
  if (!env.NOSTR_MASTER_KEY || !env.NOSTR_QUEUE) return

  // Find board user
  const boardUsers = await db
    .select()
    .from(users)
    .where(eq(users.username, 'board'))
    .limit(1)

  if (boardUsers.length === 0) return
  const board = boardUsers[0]

  if (!board.nostrPubkey || !board.nostrPrivEncrypted || !board.nostrPrivIv) return

  const boardPubkey = board.nostrPubkey
  const masterKey = env.NOSTR_MASTER_KEY

  // KV-based incremental polling
  const KV_KEY = 'board_inbox_last_poll'
  const sinceStr = await env.KV.get(KV_KEY)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 3600

  const relayUrl = relayUrls[0]
  let maxCreatedAt = since

  try {
    // Poll Kind 4 DMs to board
    const dmResult = await fetchEventsFromRelay(relayUrl, {
      kinds: [4],
      '#p': [boardPubkey],
      since,
    })

    // Poll Kind 1 mentions of board
    const mentionResult = await fetchEventsFromRelay(relayUrl, {
      kinds: [1],
      '#p': [boardPubkey],
      since,
    })

    // Poll Kind 9735 zap receipts to board
    const zapResult = await fetchEventsFromRelay(relayUrl, {
      kinds: [9735],
      '#p': [boardPubkey],
      since,
    })

    const allEvents = [...dmResult.events, ...mentionResult.events, ...zapResult.events]
    console.log(`[Board] Fetched ${allEvents.length} events (${dmResult.events.length} DMs, ${mentionResult.events.length} mentions, ${zapResult.events.length} zaps) since ${since}`)

    // Decrypt board private key once for all DMs
    const boardPrivkeyHex = await decryptNostrPrivkey(
      board.nostrPrivEncrypted!,
      board.nostrPrivIv!,
      masterKey,
    )

    for (const event of allEvents) {
      try {
        // Skip board's own messages
        if (event.pubkey === boardPubkey) {
          if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
          continue
        }

        // Dedup: check if we already created a job for this event
        const existing = await db
          .select({ id: dvmJobs.id })
          .from(dvmJobs)
          .where(eq(dvmJobs.requestEventId, event.id))
          .limit(1)
        if (existing.length > 0) {
          if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
          continue
        }

        // Handle Kind 9735 (Zap Receipt) — user zapped board to create a task
        if (event.kind === 9735) {
          const descTag = event.tags.find((t: string[]) => t[0] === 'description')
          if (!descTag || !descTag[1]) {
            if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
            continue
          }

          let zapRequest: any
          try {
            zapRequest = JSON.parse(descTag[1])
          } catch {
            if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
            continue
          }

          if (zapRequest.kind !== 9734) {
            if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
            continue
          }

          // Extract task content from zap comment
          const zapContent = (zapRequest.content || '').trim()
          if (!zapContent) {
            // Pure tip, no task — skip
            if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
            continue
          }

          const senderPubkey = zapRequest.pubkey as string
          if (!senderPubkey) {
            if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
            continue
          }

          // Extract zap amount from Kind 9734 amount tag
          const amountTag = zapRequest.tags?.find((t: string[]) => t[0] === 'amount')
          const msats = amountTag?.[1] ? parseInt(amountTag[1]) : 0
          const zapSats = msats > 0 ? Math.floor(msats / 1000) : 0

          // Content dedup check
          const fiveMinAgoZap = new Date((event.created_at - 300) * 1000)
          const zapContentDup = await db
            .select({ id: dvmJobs.id })
            .from(dvmJobs)
            .where(and(
              eq(dvmJobs.userId, board.id),
              eq(dvmJobs.role, 'customer'),
              eq(dvmJobs.input, zapContent),
              sql`${dvmJobs.createdAt} >= ${Math.floor(fiveMinAgoZap.getTime() / 1000)}`,
            ))
            .limit(1)
          if (zapContentDup.length > 0) {
            console.log(`[Board] Skipping duplicate zap content from ${senderPubkey.slice(0, 8)}...`)
            if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
            continue
          }

          // Parse intent — no BOARD_MAX_BID_SATS limit (user paid real sats)
          const intent = parseIntent(zapContent)
          const bidMsats = zapSats > 0 ? zapSats * 1000 : undefined
          console.log(`[Board] Zap from ${senderPubkey.slice(0, 8)}...: ${zapSats} sats, "${zapContent.slice(0, 80)}" → kind ${intent.kind} (${intent.label})`)

          // Build DVM job request event
          const jobEvent = await buildJobRequestEvent({
            privEncrypted: board.nostrPrivEncrypted!,
            iv: board.nostrPrivIv!,
            masterKey,
            kind: intent.kind,
            input: zapContent,
            inputType: 'text',
            bidMsats,
            relays: relayUrls,
          })

          // Save job to DB
          const jobId = generateId()
          const now = new Date()
          const params = JSON.stringify({
            board_requester_pubkey: senderPubkey,
            board_request_event_id: event.id,
            board_request_kind: 9735,
            board_bid_sats: zapSats > 0 ? zapSats : undefined,
            board_zap_receipt_id: event.id,
          })

          await db.insert(dvmJobs).values({
            id: jobId,
            userId: board.id,
            role: 'customer',
            kind: intent.kind,
            eventId: jobEvent.id,
            status: 'open',
            input: zapContent,
            inputType: 'text',
            bidMsats: bidMsats ?? null,
            customerPubkey: jobEvent.pubkey,
            requestEventId: event.id,
            params,
            createdAt: now,
            updatedAt: now,
          })

          await env.NOSTR_QUEUE.send({ events: [jobEvent] })
          console.log(`[Board] Created zap job ${jobId} (kind ${intent.kind}) for zap ${event.id.slice(0, 12)}... (${zapSats} sats)`)

          // Send confirmation via Kind 1 reply (can't DM back to a zap)
          const confirmText = `⚡ Received ${zapSats} sats zap! Working on ${intent.label}...`
          const replyEvent = await buildSignedEvent({
            privEncrypted: board.nostrPrivEncrypted!,
            iv: board.nostrPrivIv!,
            masterKey,
            kind: 1,
            content: confirmText,
            tags: [
              ['e', event.id, '', 'reply'],
              ['p', senderPubkey],
            ],
          })

          await env.NOSTR_QUEUE.send({ events: [replyEvent] })

          if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
          continue
        }

        // Extract message content
        let content: string
        const isKind4 = event.kind === 4

        if (isKind4) {
          // Decrypt Kind 4 DM
          content = await nip04Decrypt(boardPrivkeyHex, event.pubkey, event.content)
        } else {
          // Kind 1: strip nostr:npub... mentions
          content = event.content.replace(/nostr:npub[a-z0-9]+/gi, '').trim()
        }

        if (!content || content.length === 0) {
          if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
          continue
        }

        // Dedup: skip if board already has a recent job with the same input from the same pubkey
        // This catches Nostr clients that re-send the same message with different event IDs
        const fiveMinAgo = new Date((event.created_at - 300) * 1000)
        const contentDup = await db
          .select({ id: dvmJobs.id })
          .from(dvmJobs)
          .where(and(
            eq(dvmJobs.userId, board.id),
            eq(dvmJobs.role, 'customer'),
            eq(dvmJobs.input, content),
            sql`${dvmJobs.createdAt} >= ${Math.floor(fiveMinAgo.getTime() / 1000)}`,
          ))
          .limit(1)
        if (contentDup.length > 0) {
          console.log(`[Board] Skipping duplicate content from ${event.pubkey.slice(0, 8)}... (event ${event.id.slice(0, 12)}...)`)

          // Notify sender that this is a duplicate
          const dupText = 'Your message was already received and is being processed. Please wait for the result.'
          let dupReply
          if (event.kind === 4) {
            const encrypted = await nip04Encrypt(boardPrivkeyHex, event.pubkey, dupText)
            dupReply = await buildSignedEvent({
              privEncrypted: board.nostrPrivEncrypted!,
              iv: board.nostrPrivIv!,
              masterKey,
              kind: 4,
              content: encrypted,
              tags: [['p', event.pubkey]],
            })
          } else {
            dupReply = await buildSignedEvent({
              privEncrypted: board.nostrPrivEncrypted!,
              iv: board.nostrPrivIv!,
              masterKey,
              kind: 1,
              content: dupText,
              tags: [
                ['e', event.id, '', 'reply'],
                ['p', event.pubkey],
              ],
            })
          }
          await env.NOSTR_QUEUE.send({ events: [dupReply] })

          if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
          continue
        }

        // Parse intent and bid amount
        const intent = parseIntent(content)
        const maxSats = parseInt(env.BOARD_MAX_BID_SATS || '1000') || 1000
        const bidSats = parseBidSats(content, maxSats)
        const bidMsats = bidSats > 0 ? bidSats * 1000 : undefined
        console.log(`[Board] Message from ${event.pubkey.slice(0, 8)}...: "${content.slice(0, 80)}" → kind ${intent.kind} (${intent.label})${bidSats > 0 ? ` (${bidSats} sats bid)` : ''}`)

        // Build DVM job request event
        const relays = relayUrls
        const jobEvent = await buildJobRequestEvent({
          privEncrypted: board.nostrPrivEncrypted!,
          iv: board.nostrPrivIv!,
          masterKey,
          kind: intent.kind,
          input: content,
          inputType: 'text',
          bidMsats,
          relays,
        })

        // Save job to DB with board metadata in params
        const jobId = generateId()
        const now = new Date()
        const params = JSON.stringify({
          board_requester_pubkey: event.pubkey,
          board_request_event_id: event.id,
          board_request_kind: event.kind,
          board_bid_sats: bidSats > 0 ? bidSats : undefined,
        })

        await db.insert(dvmJobs).values({
          id: jobId,
          userId: board.id,
          role: 'customer',
          kind: intent.kind,
          eventId: jobEvent.id,
          status: 'open',
          input: content,
          inputType: 'text',
          bidMsats: bidMsats ?? null,
          customerPubkey: jobEvent.pubkey,
          requestEventId: event.id,
          params,
          createdAt: now,
          updatedAt: now,
        })

        // Publish DVM job to relay
        await env.NOSTR_QUEUE.send({ events: [jobEvent] })

        console.log(`[Board] Created job ${jobId} (kind ${intent.kind}) for event ${event.id}${bidSats > 0 ? ` (${bidSats} sats bid)` : ''}`)

        // Send confirmation reply
        const confirmText = confirmationMessage(intent.label, bidSats)
        let replyEvent

        if (isKind4) {
          // Reply via Kind 4 DM
          const encrypted = await nip04Encrypt(boardPrivkeyHex, event.pubkey, confirmText)
          replyEvent = await buildSignedEvent({
            privEncrypted: board.nostrPrivEncrypted!,
            iv: board.nostrPrivIv!,
            masterKey,
            kind: 4,
            content: encrypted,
            tags: [['p', event.pubkey]],
          })
        } else {
          // Reply via Kind 1 with e tag
          replyEvent = await buildSignedEvent({
            privEncrypted: board.nostrPrivEncrypted!,
            iv: board.nostrPrivIv!,
            masterKey,
            kind: 1,
            content: confirmText,
            tags: [
              ['e', event.id, '', 'reply'],
              ['p', event.pubkey],
            ],
          })
        }

        await env.NOSTR_QUEUE.send({ events: [replyEvent] })

        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
      } catch (e) {
        console.error(`[Board] Failed to process event ${event.id}:`, e)
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
      }
    }
  } catch (e) {
    console.error('[Board] Inbox poll failed:', e)
  }

  // Update KV timestamp
  if (maxCreatedAt > since) {
    await env.KV.put(KV_KEY, String(maxCreatedAt + 1))
  }
}

// --- Poll board results: send results back to users ---

export async function pollBoardResults(env: Bindings, db: Database): Promise<void> {
  if (!env.NOSTR_MASTER_KEY || !env.NOSTR_QUEUE) return

  // Find board user
  const boardUsers = await db
    .select()
    .from(users)
    .where(eq(users.username, 'board'))
    .limit(1)

  if (boardUsers.length === 0) return
  const board = boardUsers[0]

  if (!board.nostrPrivEncrypted || !board.nostrPrivIv) return

  const masterKey = env.NOSTR_MASTER_KEY

  // Find board's customer jobs with results ready
  const readyJobs = await db
    .select()
    .from(dvmJobs)
    .where(and(
      eq(dvmJobs.userId, board.id),
      eq(dvmJobs.role, 'customer'),
      eq(dvmJobs.status, 'result_available'),
    ))

  if (readyJobs.length === 0) return

  console.log(`[Board] Found ${readyJobs.length} jobs with results ready`)

  // Decrypt board private key once
  const boardPrivkeyHex = await decryptNostrPrivkey(
    board.nostrPrivEncrypted!,
    board.nostrPrivIv!,
    masterKey,
  )

  for (const job of readyJobs) {
    try {
      // Parse board metadata from params
      if (!job.params) {
        // Not a board-created job, skip
        await db.update(dvmJobs)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(dvmJobs.id, job.id))
        continue
      }

      let boardMeta: {
        board_requester_pubkey?: string
        board_request_event_id?: string
        board_request_kind?: number
        board_bid_sats?: number
      }
      try {
        boardMeta = JSON.parse(job.params)
      } catch {
        await db.update(dvmJobs)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(dvmJobs.id, job.id))
        continue
      }

      if (!boardMeta.board_requester_pubkey) {
        await db.update(dvmJobs)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(dvmJobs.id, job.id))
        continue
      }

      // Build result message (truncate to reasonable length)
      const resultText = (job.result || 'No result').slice(0, 4000)

      // Determine signer: prefer provider's keys, fall back to board
      let signerPrivEncrypted = board.nostrPrivEncrypted!
      let signerPrivIv = board.nostrPrivIv!
      let signerPrivkeyHex = boardPrivkeyHex

      if (job.providerPubkey) {
        const providerUsers = await db
          .select()
          .from(users)
          .where(eq(users.nostrPubkey, job.providerPubkey))
          .limit(1)
        if (providerUsers.length > 0 && providerUsers[0].nostrPrivEncrypted && providerUsers[0].nostrPrivIv) {
          const provider = providerUsers[0]
          signerPrivEncrypted = provider.nostrPrivEncrypted!
          signerPrivIv = provider.nostrPrivIv!
          signerPrivkeyHex = await decryptNostrPrivkey(signerPrivEncrypted, signerPrivIv, masterKey)
        }
      }

      let replyEvent
      if (boardMeta.board_request_kind === 4) {
        // Reply via Kind 4 DM
        const encrypted = await nip04Encrypt(signerPrivkeyHex, boardMeta.board_requester_pubkey, resultText)
        replyEvent = await buildSignedEvent({
          privEncrypted: signerPrivEncrypted,
          iv: signerPrivIv,
          masterKey,
          kind: 4,
          content: encrypted,
          tags: [['p', boardMeta.board_requester_pubkey]],
        })
      } else {
        // Reply via Kind 1 with e tag reference
        const tags: string[][] = [['p', boardMeta.board_requester_pubkey]]
        if (boardMeta.board_request_event_id) {
          tags.push(['e', boardMeta.board_request_event_id, '', 'reply'])
        }
        replyEvent = await buildSignedEvent({
          privEncrypted: signerPrivEncrypted,
          iv: signerPrivIv,
          masterKey,
          kind: 1,
          content: resultText,
          tags,
        })
      }

      await env.NOSTR_QUEUE.send({ events: [replyEvent] })

      console.log(`[Board] Sent result for job ${job.id} to ${boardMeta.board_requester_pubkey.slice(0, 8)}...`)

      // --- Payment: board pays provider if bid > 0 ---
      const bidSats = boardMeta.board_bid_sats || (job.bidMsats ? Math.floor(job.bidMsats / 1000) : 0)
      if (bidSats > 0 && board.nwcEncrypted && board.nwcIv && masterKey) {
        try {
          const priceSats = job.priceMsats ? Math.floor(job.priceMsats / 1000) : 0
          const paymentSats = priceSats > 0 ? Math.min(bidSats, priceSats) : bidSats

          const nwcUri = await decryptNwcUri(board.nwcEncrypted, board.nwcIv, masterKey)
          const parsed = parseNwcUri(nwcUri)

          if (job.bolt11) {
            // Provider included a bolt11 invoice
            const { preimage } = await nwcPayInvoice(parsed, job.bolt11)
            await db.update(dvmJobs)
              .set({ paymentHash: preimage, updatedAt: new Date() })
              .where(eq(dvmJobs.id, job.id))
            console.log(`[Board] Paid ${paymentSats} sats via bolt11 for job ${job.id} (preimage: ${preimage.slice(0, 16)}...)`)
          } else {
            // Find provider's lightning address
            let providerAddress: string | null = null
            if (job.providerPubkey) {
              const providerUsers = await db
                .select({ lightningAddress: users.lightningAddress })
                .from(users)
                .where(eq(users.nostrPubkey, job.providerPubkey))
                .limit(1)
              if (providerUsers.length > 0 && providerUsers[0].lightningAddress) {
                providerAddress = providerUsers[0].lightningAddress
              }
            }

            if (providerAddress) {
              const { preimage } = await resolveAndPayLightningAddress(parsed, providerAddress, paymentSats)
              await db.update(dvmJobs)
                .set({ paymentHash: preimage, updatedAt: new Date() })
                .where(eq(dvmJobs.id, job.id))
              console.log(`[Board] Paid ${paymentSats} sats to ${providerAddress} for job ${job.id}`)
            } else {
              console.warn(`[Board] No bolt11 or lightning address for job ${job.id}, skipping payment`)
            }
          }
        } catch (payErr) {
          console.error(`[Board] Payment failed for job ${job.id}:`, payErr)
        }
      }

      // Mark job as completed
      await db.update(dvmJobs)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(dvmJobs.id, job.id))
    } catch (e) {
      console.error(`[Board] Failed to send result for job ${job.id}:`, e)
    }
  }
}
