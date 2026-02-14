import { Hono } from 'hono'
import { eq, desc, and, or, sql, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders, groups, groupMembers, topics, comments, topicLikes, topicReposts, commentLikes, commentReposts, userFollows, nostrFollows, dvmJobs, dvmServices } from '../db/schema'
import { generateId, generateApiKey, ensureUniqueUsername, stripHtml } from '../lib/utils'
import { requireApiAuth } from '../middleware/auth'
import { createNotification } from '../lib/notifications'
import { generateNostrKeypair, buildSignedEvent, pubkeyToNpub, buildRepostEvent, buildZapRequestEvent, eventIdToNevent } from '../services/nostr'
import { buildJobRequestEvent, buildJobResultEvent, buildJobFeedbackEvent, buildHandlerInfoEvent } from '../services/dvm'
import { parseNwcUri, encryptNwcUri, decryptNwcUri, validateNwcConnection, nwcPayInvoice, resolveAndPayLightningAddress } from '../services/nwc'

const api = new Hono<AppContext>()

// ─── 公开端点：活动流 ───

api.get('/activity', async (c) => {
  const db = c.get('db')

  const [recentTopics, recentJobs, recentLikes, recentReposts] = await Promise.all([
    db.select({
      id: topics.id,
      content: topics.content,
      title: topics.title,
      createdAt: topics.createdAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
    })
      .from(topics)
      .leftJoin(users, eq(topics.userId, users.id))
      .orderBy(desc(topics.createdAt))
      .limit(10),
    db.select({
      id: dvmJobs.id,
      kind: dvmJobs.kind,
      status: dvmJobs.status,
      role: dvmJobs.role,
      createdAt: dvmJobs.createdAt,
      updatedAt: dvmJobs.updatedAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
    })
      .from(dvmJobs)
      .leftJoin(users, eq(dvmJobs.userId, users.id))
      .orderBy(desc(dvmJobs.updatedAt))
      .limit(10),
    db.select({
      topicId: topicLikes.topicId,
      createdAt: topicLikes.createdAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
    })
      .from(topicLikes)
      .leftJoin(users, eq(topicLikes.userId, users.id))
      .orderBy(desc(topicLikes.createdAt))
      .limit(10),
    db.select({
      topicId: topicReposts.topicId,
      createdAt: topicReposts.createdAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
    })
      .from(topicReposts)
      .leftJoin(users, eq(topicReposts.userId, users.id))
      .orderBy(desc(topicReposts.createdAt))
      .limit(10),
  ])

  const DVM_KIND_LABELS: Record<number, string> = {
    5100: 'text generation', 5200: 'text-to-image', 5250: 'video generation',
    5300: 'text-to-speech', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
  }

  const activities: { type: string; actor: string; action: string; time: Date }[] = []

  for (const t of recentTopics) {
    activities.push({
      type: 'post',
      actor: t.authorDisplayName || t.authorUsername || 'unknown',
      action: 'posted a note',
      time: t.createdAt,
    })
  }

  for (const j of recentJobs) {
    const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
    let action = ''
    if (j.role === 'customer') {
      if (j.status === 'open') action = `requested DVM job (${kindLabel})`
      else if (j.status === 'completed') action = `completed DVM job (${kindLabel})`
      else action = `updated DVM job (${kindLabel})`
    } else {
      if (j.status === 'completed') action = `fulfilled DVM job (${kindLabel})`
      else if (j.status === 'processing') action = `is processing DVM job (${kindLabel})`
      else action = `accepted DVM job (${kindLabel})`
    }
    activities.push({
      type: 'dvm_job',
      actor: j.authorDisplayName || j.authorUsername || 'unknown',
      action,
      time: j.updatedAt,
    })
  }

  for (const l of recentLikes) {
    activities.push({
      type: 'like',
      actor: l.authorDisplayName || l.authorUsername || 'unknown',
      action: 'liked a post',
      time: l.createdAt,
    })
  }

  for (const r of recentReposts) {
    activities.push({
      type: 'repost',
      actor: r.authorDisplayName || r.authorUsername || 'unknown',
      action: 'reposted a note',
      time: r.createdAt,
    })
  }

  activities.sort((a, b) => b.time.getTime() - a.time.getTime())

  return c.json(activities.slice(0, 20))
})

// ─── 公开端点：注册 ───

api.post('/auth/register', async (c) => {
  const db = c.get('db')
  const body = await c.req.json().catch(() => ({})) as { name?: string }
  const name = body.name?.trim()

  if (!name || name.length < 1 || name.length > 50) {
    return c.json({ error: 'name is required (1-50 chars)' }, 400)
  }

  // KV 限流：每 IP 5 分钟 1 次（暂时关闭用于调试）
  // const kv = c.env.KV
  // const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  // const rateKey = `api_reg:${ip}`
  // const existing = await kv.get(rateKey)
  // if (existing) {
  //   return c.json({ error: 'Rate limited. Try again in 5 minutes.' }, 429)
  // }
  // await kv.put(rateKey, '1', { expirationTtl: 300 })

  // 生成 username（slug 化 name）
  const baseUsername = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'agent'
  const username = await ensureUniqueUsername(db, baseUsername)

  // 生成 API key
  const { key, hash, keyId } = await generateApiKey()

  const userId = generateId()
  const now = new Date()

  // 创建用户
  try {
    await db.insert(users).values({
      id: userId,
      username,
      displayName: name,
      createdAt: now,
      updatedAt: now,
    })
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
    const cause2 = e instanceof Error && e.cause instanceof Error && e.cause.cause instanceof Error ? e.cause.cause.message : ''
    console.error('[Register] insert user failed:', e instanceof Error ? e.message : e)
    return c.json({ error: 'Failed to create user', detail: e instanceof Error ? e.message : 'unknown', cause, cause2 }, 500)
  }

  // 创建 authProvider
  try {
    await db.insert(authProviders).values({
      id: keyId,
      userId,
      providerType: 'apikey',
      providerId: `apikey:${username}`,
      accessToken: hash,
      createdAt: now,
    })
  } catch (e) {
    console.error('[Register] insert authProvider failed:', e instanceof Error ? e.message : e, e instanceof Error ? e.cause : '')
    return c.json({ error: 'Failed to create auth', detail: e instanceof Error ? e.message : 'unknown' }, 500)
  }

  // 自动生成 Nostr 密钥并开启同步
  if (c.env.NOSTR_MASTER_KEY) {
    try {
      const { pubkey, privEncrypted, iv } = await generateNostrKeypair(c.env.NOSTR_MASTER_KEY)
      await db.update(users).set({
        nostrPubkey: pubkey,
        nostrPrivEncrypted: privEncrypted,
        nostrPrivIv: iv,
        nostrKeyVersion: 1,
        nostrSyncEnabled: 1,
        updatedAt: new Date(),
      }).where(eq(users.id, userId))

      // 广播 Kind 0 metadata
      if (c.env.NOSTR_QUEUE) {
        const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
        const host = new URL(baseUrl).host
        const metaEvent = await buildSignedEvent({
          privEncrypted, iv, masterKey: c.env.NOSTR_MASTER_KEY,
          kind: 0,
          content: JSON.stringify({
            name,
            about: '',
            picture: '',
            nip05: `${username}@${host}`,
            ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
          }),
          tags: [],
        })
        c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [metaEvent] }))
      }
    } catch (e) {
      console.error('[API] Failed to generate Nostr keys:', e)
    }
  }

  return c.json({
    user_id: userId,
    username,
    api_key: key,
    message: 'Save your API key — it will not be shown again.',
  }, 201)
})

// ─── 认证端点 ───

// GET /api/me
api.get('/me', requireApiAuth, async (c) => {
  const user = c.get('user')!
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Derive NWC relay URL if enabled
  let nwcRelayUrl: string | undefined
  if (user.nwcEnabled && user.nwcEncrypted && user.nwcIv && c.env.NOSTR_MASTER_KEY) {
    try {
      const uri = await decryptNwcUri(user.nwcEncrypted, user.nwcIv, c.env.NOSTR_MASTER_KEY)
      const parsed = parseNwcUri(uri)
      nwcRelayUrl = parsed.relayUrl
    } catch {}
  }

  return c.json({
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    avatar_url: user.avatarUrl,
    bio: user.bio,
    lightning_address: user.lightningAddress || null,
    profile_url: `${baseUrl}/user/${user.id}`,
    nwc_enabled: !!user.nwcEnabled,
    ...(nwcRelayUrl ? { nwc_relay_url: nwcRelayUrl } : {}),
  })
})

// PUT /api/me
api.put('/me', requireApiAuth, async (c) => {
  const user = c.get('user')!
  const db = c.get('db')
  const body = await c.req.json().catch(() => ({})) as { display_name?: string; bio?: string; lightning_address?: string | null; nwc_connection_string?: string | null }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.display_name !== undefined) updates.displayName = body.display_name.slice(0, 100)
  if (body.bio !== undefined) updates.bio = body.bio.slice(0, 500)
  if (body.lightning_address !== undefined) updates.lightningAddress = body.lightning_address

  // Handle NWC connection string
  if (body.nwc_connection_string !== undefined) {
    if (body.nwc_connection_string === null || body.nwc_connection_string === '') {
      // Disconnect NWC
      updates.nwcEncrypted = null
      updates.nwcIv = null
      updates.nwcEnabled = 0
    } else {
      // Validate and store NWC connection
      if (!c.env.NOSTR_MASTER_KEY) {
        return c.json({ error: 'NWC not available: encryption key not configured' }, 500)
      }
      try {
        parseNwcUri(body.nwc_connection_string)
      } catch (e: any) {
        return c.json({ error: e.message }, 400)
      }

      // Optional: validate connection is reachable
      try {
        await validateNwcConnection(body.nwc_connection_string)
      } catch (e) {
        console.warn('[NWC] Connection validation failed (non-blocking):', e)
      }

      const { encrypted, iv } = await encryptNwcUri(body.nwc_connection_string, c.env.NOSTR_MASTER_KEY)
      updates.nwcEncrypted = encrypted
      updates.nwcIv = iv
      updates.nwcEnabled = 1
    }
  }

  await db.update(users).set(updates).where(eq(users.id, user.id))

  // 更新 Nostr Kind 0 if enabled
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    try {
      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      const host = new URL(baseUrl).host
      const metaEvent = await buildSignedEvent({
        privEncrypted: user.nostrPrivEncrypted!,
        iv: user.nostrPrivIv!,
        masterKey: c.env.NOSTR_MASTER_KEY,
        kind: 0,
        content: JSON.stringify({
          name: (body.display_name !== undefined ? body.display_name.slice(0, 100) : user.displayName) || user.username,
          about: body.bio !== undefined ? stripHtml(body.bio.slice(0, 500)) : (user.bio ? stripHtml(user.bio) : ''),
          picture: user.avatarUrl || '',
          nip05: `${user.username}@${host}`,
          ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
        }),
        tags: [],
      })
      c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [metaEvent] }))
    } catch (e) {
      console.error('[API] Failed to update Nostr metadata:', e)
    }
  }

  return c.json({ ok: true })
})

// GET /api/groups
api.get('/groups', requireApiAuth, async (c) => {
  const db = c.get('db')

  const allGroups = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      icon_url: groups.iconUrl,
      member_count: sql<number>`(SELECT COUNT(*) FROM group_member WHERE group_member.group_id = "group".id)`,
      topic_count: sql<number>`(SELECT COUNT(*) FROM topic WHERE topic.group_id = "group".id)`,
    })
    .from(groups)
    .orderBy(desc(groups.updatedAt))

  return c.json({ groups: allGroups })
})

// GET /api/groups/:id/topics
api.get('/groups/:id/topics', requireApiAuth, async (c) => {
  const db = c.get('db')
  const groupId = c.req.param('id')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  // Check group exists
  const group = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).limit(1)
  if (group.length === 0) return c.json({ error: 'Group not found' }, 404)

  const topicList = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      nostr_author_pubkey: topics.nostrAuthorPubkey,
      created_at: topics.createdAt,
      author_id: users.id,
      author_username: users.username,
      author_display_name: users.displayName,
      comment_count: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = topic.id)`,
      like_count: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = topic.id)`,
    })
    .from(topics)
    .leftJoin(users, eq(topics.userId, users.id))
    .where(eq(topics.groupId, groupId))
    .orderBy(desc(topics.updatedAt))
    .limit(limit)
    .offset(offset)

  const result = topicList.map(t => ({
    id: t.id,
    title: t.title,
    content: t.content ? stripHtml(t.content).slice(0, 300) : null,
    created_at: t.created_at,
    author: t.author_id
      ? { id: t.author_id, username: t.author_username, display_name: t.author_display_name }
      : { pubkey: t.nostr_author_pubkey, npub: t.nostr_author_pubkey ? pubkeyToNpub(t.nostr_author_pubkey) : null },
    comment_count: t.comment_count,
    like_count: t.like_count,
  }))

  return c.json({ topics: result, page, limit })
})

// GET /api/topics/:id
api.get('/topics/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const topicId = c.req.param('id')

  const topicResult = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      group_id: topics.groupId,
      nostr_author_pubkey: topics.nostrAuthorPubkey,
      nostr_event_id: topics.nostrEventId,
      created_at: topics.createdAt,
      author_id: users.id,
      author_username: users.username,
      author_display_name: users.displayName,
    })
    .from(topics)
    .leftJoin(users, eq(topics.userId, users.id))
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  const t = topicResult[0]

  // 获取评论
  const commentList = await db
    .select({
      id: comments.id,
      content: comments.content,
      reply_to_id: comments.replyToId,
      nostr_author_pubkey: comments.nostrAuthorPubkey,
      created_at: comments.createdAt,
      author_id: users.id,
      author_username: users.username,
      author_display_name: users.displayName,
    })
    .from(comments)
    .leftJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.topicId, topicId))
    .orderBy(comments.createdAt)

  return c.json({
    topic: {
      id: t.id,
      title: t.title,
      content: t.content ? stripHtml(t.content) : null,
      group_id: t.group_id,
      nostr_event_id: t.nostr_event_id,
      created_at: t.created_at,
      author: t.author_id
        ? { id: t.author_id, username: t.author_username, display_name: t.author_display_name }
        : { pubkey: t.nostr_author_pubkey, npub: t.nostr_author_pubkey ? pubkeyToNpub(t.nostr_author_pubkey) : null },
    },
    comments: commentList.map(cm => ({
      id: cm.id,
      content: cm.content ? stripHtml(cm.content) : null,
      reply_to_id: cm.reply_to_id,
      created_at: cm.created_at,
      author: cm.author_id
        ? { id: cm.author_id, username: cm.author_username, display_name: cm.author_display_name }
        : { pubkey: cm.nostr_author_pubkey, npub: cm.nostr_author_pubkey ? pubkeyToNpub(cm.nostr_author_pubkey) : null },
    })),
  })
})

// POST /api/groups/:id/topics — 发帖
api.post('/groups/:id/topics', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const groupId = c.req.param('id')

  const body = await c.req.json().catch(() => ({})) as { title?: string; content?: string }
  const title = body.title?.trim()
  const content = body.content?.trim() || null

  if (!title || title.length < 1 || title.length > 200) {
    return c.json({ error: 'title is required (1-200 chars)' }, 400)
  }

  // Check group exists
  const groupData = await db.select({ id: groups.id, name: groups.name, nostrSyncEnabled: groups.nostrSyncEnabled, nostrPubkey: groups.nostrPubkey })
    .from(groups).where(eq(groups.id, groupId)).limit(1)
  if (groupData.length === 0) return c.json({ error: 'Group not found' }, 404)

  // 自动加入小组
  const membership = await db.select({ id: groupMembers.id })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (membership.length === 0) {
    await db.insert(groupMembers).values({
      id: generateId(),
      groupId,
      userId: user.id,
      createdAt: new Date(),
    })
  }

  const topicId = generateId()
  const now = new Date()

  await db.insert(topics).values({
    id: topicId,
    groupId,
    userId: user.id,
    title,
    content,
    type: 0,
    createdAt: now,
    updatedAt: now,
  })

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Nostr: broadcast Kind 1
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const textContent = content ? stripHtml(content) : ''
        const noteContent = textContent
          ? `${title}\n\n${textContent}\n\n🔗 ${baseUrl}/topic/${topicId}`
          : `${title}\n\n🔗 ${baseUrl}/topic/${topicId}`

        const nostrTags: string[][] = [
          ['r', `${baseUrl}/topic/${topicId}`],
          ['client', c.env.APP_NAME || 'NeoGroup'],
        ]

        // NIP-72 community a-tag
        if (groupData[0].nostrSyncEnabled === 1 && groupData[0].nostrPubkey && groupData[0].name) {
          const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
          nostrTags.push(['a', `34550:${groupData[0].nostrPubkey}:${groupData[0].name}`, relayUrl])
        }

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags: nostrTags,
        })

        await db.update(topics).set({ nostrEventId: event.id }).where(eq(topics.id, topicId))
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish topic:', e)
      }
    })())
  }

  return c.json({
    id: topicId,
    url: `${baseUrl}/topic/${topicId}`,
  }, 201)
})

// POST /api/topics/:id/comments — 评论
api.post('/topics/:id/comments', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const body = await c.req.json().catch(() => ({})) as { content?: string; reply_to_id?: string }
  const content = body.content?.trim()
  const replyToId = body.reply_to_id || null

  if (!content || content.length < 1 || content.length > 5000) {
    return c.json({ error: 'content is required (1-5000 chars)' }, 400)
  }

  // Check topic exists
  const topicResult = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  // Validate reply_to_id
  if (replyToId) {
    const parent = await db.select({ id: comments.id }).from(comments)
      .where(and(eq(comments.id, replyToId), eq(comments.topicId, topicId))).limit(1)
    if (parent.length === 0) return c.json({ error: 'reply_to_id not found in this topic' }, 400)
  }

  const commentId = generateId()
  const now = new Date()
  const htmlContent = `<p>${content.replace(/\n/g, '</p><p>')}</p>`

  await db.insert(comments).values({
    id: commentId,
    topicId,
    userId: user.id,
    content: htmlContent,
    replyToId,
    createdAt: now,
    updatedAt: now,
  })

  // 更新话题 updatedAt
  await db.update(topics).set({ updatedAt: now }).where(eq(topics.id, topicId))

  // 通知话题作者 (only if local user)
  if (topicResult[0].userId) {
    await createNotification(db, {
      userId: topicResult[0].userId,
      actorId: user.id,
      type: 'reply',
      topicId,
    })
  }

  // 如果是回复评论，通知该评论作者 (only if local user)
  if (replyToId) {
    const replyComment = await db.select({ userId: comments.userId }).from(comments).where(eq(comments.id, replyToId)).limit(1)
    if (replyComment.length > 0 && replyComment[0].userId && replyComment[0].userId !== topicResult[0].userId) {
      await createNotification(db, {
        userId: replyComment[0].userId,
        actorId: user.id,
        type: 'comment_reply',
        topicId,
        commentId: replyToId,
      })
    }
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Nostr: broadcast comment as Kind 1
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const textContent = stripHtml(htmlContent)
        const noteContent = `${textContent}\n\n🔗 ${baseUrl}/topic/${topicId}#comment-${commentId}`

        const tags: string[][] = [
          ['r', `${baseUrl}/topic/${topicId}`],
          ['client', c.env.APP_NAME || 'NeoGroup'],
        ]

        // Thread: root = topic nostr event
        if (topicResult[0].nostrEventId) {
          tags.push(['e', topicResult[0].nostrEventId, '', 'root'])
        }

        // Thread: reply = parent comment nostr event
        if (replyToId) {
          const parentComment = await db.select({ nostrEventId: comments.nostrEventId })
            .from(comments).where(eq(comments.id, replyToId)).limit(1)
          if (parentComment.length > 0 && parentComment[0].nostrEventId) {
            tags.push(['e', parentComment[0].nostrEventId, '', 'reply'])
          }
        }

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags,
        })

        await db.update(comments).set({ nostrEventId: event.id }).where(eq(comments.id, commentId))
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish comment:', e)
      }
    })())
  }

  return c.json({
    id: commentId,
    url: `${baseUrl}/topic/${topicId}#comment-${commentId}`,
  }, 201)
})

// ─── Timeline: 个人动态 ───

// POST /api/posts — 发布个人动态
api.post('/posts', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const body = await c.req.json().catch(() => ({})) as { content?: string }
  const content = body.content?.trim()

  if (!content || content.length < 1 || content.length > 5000) {
    return c.json({ error: 'content is required (1-5000 chars)' }, 400)
  }

  const topicId = generateId()
  const now = new Date()
  const htmlContent = `<p>${content.replace(/\n/g, '</p><p>')}</p>`

  await db.insert(topics).values({
    id: topicId,
    groupId: null,
    userId: user.id,
    title: '',
    content: htmlContent,
    type: 0,
    createdAt: now,
    updatedAt: now,
  })

  // Nostr: build Kind 1 event synchronously so we can return nevent
  let nostrEventId: string | null = null
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY) {
    try {
      const textContent = stripHtml(htmlContent).trim()
      const event = await buildSignedEvent({
        privEncrypted: user.nostrPrivEncrypted!,
        iv: user.nostrPrivIv!,
        masterKey: c.env.NOSTR_MASTER_KEY!,
        kind: 1,
        content: textContent,
        tags: [['client', c.env.APP_NAME || 'NeoGroup']],
      })
      nostrEventId = event.id
      await db.update(topics).set({ nostrEventId: event.id }).where(eq(topics.id, topicId))
      if (c.env.NOSTR_QUEUE) {
        c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event] }))
      }
    } catch (e) {
      console.error('[API/Nostr] Failed to publish personal post:', e)
    }
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const relays = (c.env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)

  return c.json({
    id: topicId,
    url: `${baseUrl}/topic/${topicId}`,
    ...(nostrEventId
      ? { nevent: eventIdToNevent(nostrEventId, relays, user.nostrPubkey || undefined) }
      : {}),
  }, 201)
})

// POST /api/topics/:id/like — 点赞话题
api.post('/topics/:id/like', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const existing = await db.select({ id: topicLikes.id })
    .from(topicLikes)
    .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
    .limit(1)

  if (existing.length > 0) {
    // Unlike
    await db.delete(topicLikes)
      .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
    return c.json({ liked: false })
  }

  await db.insert(topicLikes).values({
    id: generateId(),
    topicId,
    userId: user.id,
    createdAt: new Date(),
  })

  // Notification (only if local user)
  const topicData = await db.select({ userId: topics.userId }).from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicData.length > 0 && topicData[0].userId) {
    await createNotification(db, {
      userId: topicData[0].userId,
      actorId: user.id,
      type: 'topic_like',
      topicId,
    })
  }

  return c.json({ liked: true })
})

// DELETE /api/topics/:id/like — 取消点赞
api.delete('/topics/:id/like', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  await db.delete(topicLikes)
    .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))

  return c.json({ liked: false })
})

// DELETE /api/topics/:id — 删除话题
api.delete('/topics/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const topicResult = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  if (!topicResult[0].userId || topicResult[0].userId !== user.id) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Nostr Kind 5: deletion event
  if (topicResult[0].nostrEventId && user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 5,
          content: '',
          tags: [['e', topicResult[0].nostrEventId!]],
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to send Kind 5 deletion:', e)
      }
    })())
  }

  // 级联删除
  const topicComments = await db.select({ id: comments.id }).from(comments).where(eq(comments.topicId, topicId))
  for (const comment of topicComments) {
    await db.delete(commentLikes).where(eq(commentLikes.commentId, comment.id))
    await db.delete(commentReposts).where(eq(commentReposts.commentId, comment.id))
  }
  await db.delete(comments).where(eq(comments.topicId, topicId))
  await db.delete(topicLikes).where(eq(topicLikes.topicId, topicId))
  await db.delete(topicReposts).where(eq(topicReposts.topicId, topicId))
  await db.delete(topics).where(eq(topics.id, topicId))

  return c.json({ success: true })
})

// ─── Nostr Follow ───

// POST /api/nostr/follow
api.post('/nostr/follow', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const { pubkeyToNpub, npubToPubkey } = await import('../services/nostr')

  const body = await c.req.json().catch(() => ({})) as { pubkey?: string }
  const target = body.pubkey?.trim()
  if (!target) return c.json({ error: 'pubkey is required' }, 400)

  let pubkey: string | null = null
  let npub: string | null = null

  if (target.startsWith('npub1')) {
    pubkey = npubToPubkey(target)
    npub = target
  } else if (/^[0-9a-f]{64}$/i.test(target)) {
    pubkey = target.toLowerCase()
    npub = pubkeyToNpub(pubkey)
  }

  if (!pubkey) return c.json({ error: 'Invalid pubkey or npub' }, 400)

  const existing = await db.select({ id: nostrFollows.id })
    .from(nostrFollows)
    .where(and(eq(nostrFollows.userId, user.id), eq(nostrFollows.targetPubkey, pubkey)))
    .limit(1)

  if (existing.length > 0) return c.json({ ok: true, already_following: true })

  await db.insert(nostrFollows).values({
    id: generateId(),
    userId: user.id,
    targetPubkey: pubkey,
    targetNpub: npub,
    createdAt: new Date(),
  })

  return c.json({ ok: true })
})

// DELETE /api/nostr/follow/:pubkey
api.delete('/nostr/follow/:pubkey', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const pubkey = c.req.param('pubkey')

  await db.delete(nostrFollows)
    .where(and(eq(nostrFollows.userId, user.id), eq(nostrFollows.targetPubkey, pubkey)))

  return c.json({ ok: true })
})

// GET /api/nostr/following
api.get('/nostr/following', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const list = await db.select({
    id: nostrFollows.id,
    target_pubkey: nostrFollows.targetPubkey,
    target_npub: nostrFollows.targetNpub,
    target_display_name: nostrFollows.targetDisplayName,
    created_at: nostrFollows.createdAt,
  })
    .from(nostrFollows)
    .where(eq(nostrFollows.userId, user.id))
    .orderBy(desc(nostrFollows.createdAt))

  return c.json({ following: list })
})

// ─── Feed: 时间线 ───

// GET /api/feed
api.get('/feed', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  const feedTopics = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      nostr_event_id: topics.nostrEventId,
      nostr_author_pubkey: topics.nostrAuthorPubkey,
      created_at: topics.createdAt,
      author_id: users.id,
      author_username: users.username,
      author_display_name: users.displayName,
      author_avatar_url: users.avatarUrl,
    })
    .from(topics)
    .leftJoin(users, eq(topics.userId, users.id))
    .where(
      or(
        eq(topics.userId, user.id),
        sql`${topics.userId} IN (SELECT ${userFollows.followeeId} FROM ${userFollows} WHERE ${userFollows.followerId} = ${user.id})`,
        sql`${topics.nostrAuthorPubkey} IN (SELECT ${nostrFollows.targetPubkey} FROM ${nostrFollows} WHERE ${nostrFollows.userId} = ${user.id})`,
      )
    )
    .orderBy(desc(topics.createdAt))
    .limit(limit)
    .offset(offset)

  // Collect external pubkeys for display name enrichment
  const externalPubkeys = feedTopics
    .filter(t => !t.author_id && t.nostr_author_pubkey)
    .map(t => t.nostr_author_pubkey!)
  const uniquePubkeys = [...new Set(externalPubkeys)]

  // Batch fetch display info from nostr_follow cache
  let pubkeyDisplayMap = new Map<string, { display_name: string | null; avatar_url: string | null }>()
  if (uniquePubkeys.length > 0) {
    const followInfo = await db
      .select({
        targetPubkey: nostrFollows.targetPubkey,
        targetDisplayName: nostrFollows.targetDisplayName,
        targetAvatarUrl: nostrFollows.targetAvatarUrl,
      })
      .from(nostrFollows)
      .where(sql`${nostrFollows.targetPubkey} IN (${sql.join(uniquePubkeys.map(p => sql`${p}`), sql`,`)})`)
    for (const f of followInfo) {
      if (!pubkeyDisplayMap.has(f.targetPubkey)) {
        pubkeyDisplayMap.set(f.targetPubkey, { display_name: f.targetDisplayName, avatar_url: f.targetAvatarUrl })
      }
    }
  }

  const result = feedTopics.map(t => {
    let author: Record<string, unknown>
    if (t.author_id) {
      author = { id: t.author_id, username: t.author_username, display_name: t.author_display_name, avatar_url: t.author_avatar_url }
    } else {
      const cached = t.nostr_author_pubkey ? pubkeyDisplayMap.get(t.nostr_author_pubkey) : undefined
      author = {
        pubkey: t.nostr_author_pubkey,
        npub: t.nostr_author_pubkey ? pubkeyToNpub(t.nostr_author_pubkey) : null,
        display_name: cached?.display_name || null,
        avatar_url: cached?.avatar_url || null,
      }
    }
    return {
      id: t.id,
      title: t.title,
      content: t.content ? stripHtml(t.content).slice(0, 300) : null,
      nostr_event_id: t.nostr_event_id,
      created_at: t.created_at,
      author,
    }
  })

  return c.json({ topics: result, page, limit })
})

// ─── Repost ───

// POST /api/topics/:id/repost
api.post('/topics/:id/repost', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  // Check topic exists
  const topicData = await db.select({
    id: topics.id,
    userId: topics.userId,
    nostrEventId: topics.nostrEventId,
    nostrAuthorPubkey: topics.nostrAuthorPubkey,
  }).from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicData.length === 0) return c.json({ error: 'Topic not found' }, 404)

  // Dedup
  const existing = await db.select({ id: topicReposts.id })
    .from(topicReposts)
    .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))
    .limit(1)
  if (existing.length > 0) return c.json({ ok: true, already_reposted: true })

  await db.insert(topicReposts).values({
    id: generateId(),
    topicId,
    userId: user.id,
    createdAt: new Date(),
  })

  // Nostr: broadcast Kind 6 repost
  if (topicData[0].nostrEventId && user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    const authorPubkey = topicData[0].nostrAuthorPubkey || user.nostrPubkey || ''
    const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildRepostEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          eventId: topicData[0].nostrEventId!,
          authorPubkey,
          relayUrl,
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish repost:', e)
      }
    })())
  }

  // Notify original author (if local user)
  if (topicData[0].userId && topicData[0].userId !== user.id) {
    await createNotification(db, {
      userId: topicData[0].userId,
      actorId: user.id,
      type: 'topic_repost',
      topicId,
    })
  }

  return c.json({ ok: true }, 201)
})

// DELETE /api/topics/:id/repost
api.delete('/topics/:id/repost', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  await db.delete(topicReposts)
    .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))

  return c.json({ ok: true })
})

// ─── Zap (NIP-57) ───

// POST /api/zap
api.post('/zap', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nwcEnabled || !user.nwcEncrypted || !user.nwcIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'NWC wallet not configured. Connect a wallet via PUT /api/me.' }, 400)
  }
  if (!user.nostrPrivEncrypted || !user.nostrPrivIv) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    target_pubkey?: string
    event_id?: string
    amount_sats?: number
    comment?: string
  }

  if (!body.target_pubkey || !/^[0-9a-f]{64}$/i.test(body.target_pubkey)) {
    return c.json({ error: 'target_pubkey is required (64 hex chars)' }, 400)
  }
  if (!body.amount_sats || body.amount_sats < 1) {
    return c.json({ error: 'amount_sats is required (>= 1)' }, 400)
  }

  const targetPubkey = body.target_pubkey.toLowerCase()
  const amountSats = body.amount_sats
  const amountMsats = amountSats * 1000

  // Find target's Lightning Address
  let lightningAddress: string | null = null

  // Check local user first
  const localTarget = await db.select({ lightningAddress: users.lightningAddress })
    .from(users).where(eq(users.nostrPubkey, targetPubkey)).limit(1)
  if (localTarget.length > 0) {
    lightningAddress = localTarget[0].lightningAddress
  }

  // If not found locally, fetch Kind 0 from relay
  if (!lightningAddress) {
    const relayUrls = (c.env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
    if (relayUrls.length > 0) {
      const { fetchEventsFromRelay } = await import('../services/nostr-community')
      for (const relayUrl of relayUrls) {
        try {
          const { events } = await fetchEventsFromRelay(relayUrl, {
            kinds: [0],
            authors: [targetPubkey],
            limit: 1,
          })
          if (events.length > 0) {
            const meta = JSON.parse(events[0].content) as { lud16?: string }
            if (meta.lud16) {
              lightningAddress = meta.lud16
              break
            }
          }
        } catch {}
      }
    }
  }

  if (!lightningAddress) {
    return c.json({ error: 'Target has no Lightning Address (lud16)' }, 400)
  }

  // LNURL-pay step 1: fetch metadata
  const [lnUser, lnDomain] = lightningAddress.split('@')
  if (!lnUser || !lnDomain) return c.json({ error: `Invalid Lightning Address: ${lightningAddress}` }, 400)

  const metaResp = await fetch(`https://${lnDomain}/.well-known/lnurlp/${lnUser}`)
  if (!metaResp.ok) return c.json({ error: `LNURL fetch failed (${metaResp.status})` }, 502)

  const meta = await metaResp.json() as {
    callback: string; minSendable: number; maxSendable: number; tag: string; allowsNostr?: boolean; nostrPubkey?: string
  }
  if (meta.tag !== 'payRequest') return c.json({ error: `Unexpected LNURL tag: ${meta.tag}` }, 502)

  if (amountMsats < meta.minSendable || amountMsats > meta.maxSendable) {
    return c.json({ error: `Amount ${amountSats} sats out of range [${meta.minSendable / 1000}-${meta.maxSendable / 1000}]` }, 400)
  }

  // Build zap request (Kind 9734) if LNURL supports Nostr zaps
  let zapRequestParam = ''
  if (meta.allowsNostr && meta.nostrPubkey) {
    const relays = (c.env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
    // Encode lightning address as lnurl (bech32)
    const lnurlBytes = new TextEncoder().encode(`https://${lnDomain}/.well-known/lnurlp/${lnUser}`)
    const { bech32 } = await import('bech32')
    const lnurlEncoded = bech32.encode('lnurl', bech32.toWords(Array.from(lnurlBytes)), 1500)

    const zapRequest = await buildZapRequestEvent({
      privEncrypted: user.nostrPrivEncrypted!,
      iv: user.nostrPrivIv!,
      masterKey: c.env.NOSTR_MASTER_KEY!,
      targetPubkey,
      eventId: body.event_id,
      amountMsats,
      comment: body.comment,
      relays,
      lnurl: lnurlEncoded,
    })
    zapRequestParam = encodeURIComponent(JSON.stringify(zapRequest))
  }

  // LNURL-pay step 2: get invoice
  const sep = meta.callback.includes('?') ? '&' : '?'
  let callbackUrl = `${meta.callback}${sep}amount=${amountMsats}`
  if (zapRequestParam) {
    callbackUrl += `&nostr=${zapRequestParam}`
  }
  if (body.comment) {
    callbackUrl += `&comment=${encodeURIComponent(body.comment)}`
  }

  const invoiceResp = await fetch(callbackUrl)
  if (!invoiceResp.ok) return c.json({ error: `LNURL callback failed (${invoiceResp.status})` }, 502)

  const invoiceData = await invoiceResp.json() as { pr: string }
  if (!invoiceData.pr) return c.json({ error: 'No invoice returned from LNURL callback' }, 502)

  // Step 3: pay via NWC
  const nwcUri = await decryptNwcUri(user.nwcEncrypted!, user.nwcIv!, c.env.NOSTR_MASTER_KEY!)
  const nwcParsed = parseNwcUri(nwcUri)

  try {
    const result = await nwcPayInvoice(nwcParsed, invoiceData.pr)
    return c.json({ ok: true, paid_sats: amountSats, preimage: result.preimage })
  } catch (e) {
    return c.json({
      error: 'NWC payment failed',
      detail: e instanceof Error ? e.message : 'Unknown error',
    }, 502)
  }
})

// ─── DVM (NIP-90 Data Vending Machine) ───

// GET /api/dvm/market — 公开：可接单的任务列表（无需认证）
api.get('/dvm/market', async (c) => {
  const db = c.get('db')
  const kindFilter = c.req.query('kind') // 可选 kind 过滤
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const page = parseInt(c.req.query('page') || '1')
  const offset = (page - 1) * limit

  const conditions = [
    eq(dvmJobs.role, 'customer'),
    inArray(dvmJobs.status, ['open', 'error']),
  ]
  if (kindFilter) {
    const k = parseInt(kindFilter)
    if (k >= 5000 && k <= 5999) {
      conditions.push(eq(dvmJobs.kind, k))
    }
  }

  const jobs = await db
    .select({
      id: dvmJobs.id,
      kind: dvmJobs.kind,
      status: dvmJobs.status,
      input: dvmJobs.input,
      inputType: dvmJobs.inputType,
      output: dvmJobs.output,
      bidMsats: dvmJobs.bidMsats,
      params: dvmJobs.params,
      createdAt: dvmJobs.createdAt,
    })
    .from(dvmJobs)
    .where(and(...conditions))
    .orderBy(desc(dvmJobs.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({
    jobs: jobs.map(j => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      input: j.input,
      input_type: j.inputType,
      output: j.output,
      bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0,
      params: j.params ? JSON.parse(j.params) : null,
      created_at: j.createdAt,
      accept_url: `/api/dvm/jobs/${j.id}/accept`,
    })),
    page,
    limit,
  })
})

// POST /api/dvm/request — Customer: 发布 Job Request
api.post('/dvm/request', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    kind?: number
    input?: string
    input_type?: string
    output?: string
    bid_sats?: number
    params?: Record<string, string>
  }

  const kind = body.kind
  if (!kind || kind < 5000 || kind > 5999) {
    return c.json({ error: 'kind must be between 5000 and 5999' }, 400)
  }

  const input = body.input?.trim()
  if (!input) {
    return c.json({ error: 'input is required' }, 400)
  }

  const inputType = body.input_type || 'text'
  const bidSats = body.bid_sats || 0
  const bidMsats = bidSats ? bidSats * 1000 : undefined

  const relays = (c.env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)

  const event = await buildJobRequestEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    kind,
    input,
    inputType,
    output: body.output,
    bidMsats,
    extraParams: body.params,
    relays,
  })

  // Save to DB
  const jobId = generateId()
  const now = new Date()
  await db.insert(dvmJobs).values({
    id: jobId,
    userId: user.id,
    role: 'customer',
    kind,
    eventId: event.id,
    status: 'open',
    input,
    inputType,
    output: body.output || null,
    bidMsats: bidMsats || null,
    customerPubkey: event.pubkey,
    requestEventId: event.id,
    params: body.params ? JSON.stringify(body.params) : null,
    createdAt: now,
    updatedAt: now,
  })

  // Publish to relay
  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event] }))
  }

  // 同站直投：如果本站有注册了对应 Kind 的 Provider，直接创建 provider job
  c.executionCtx.waitUntil((async () => {
    try {
      const activeServices = await db
        .select({ userId: dvmServices.userId, kinds: dvmServices.kinds })
        .from(dvmServices)
        .where(eq(dvmServices.active, 1))

      for (const svc of activeServices) {
        if (svc.userId === user.id) continue // 不给自己投递
        try {
          const svcKinds = JSON.parse(svc.kinds) as number[]
          if (!svcKinds.includes(kind)) continue

          // 检查是否已存在（防重复）
          const existing = await db
            .select({ id: dvmJobs.id })
            .from(dvmJobs)
            .where(and(
              eq(dvmJobs.requestEventId, event.id),
              eq(dvmJobs.userId, svc.userId),
            ))
            .limit(1)
          if (existing.length > 0) continue

          await db.insert(dvmJobs).values({
            id: generateId(),
            userId: svc.userId,
            role: 'provider',
            kind,
            status: 'open',
            input,
            inputType,
            output: body.output || null,
            bidMsats: bidMsats || null,
            customerPubkey: event.pubkey,
            requestEventId: event.id,
            params: body.params ? JSON.stringify(body.params) : null,
            createdAt: now,
            updatedAt: now,
          })
          console.log(`[DVM] Local delivery: job ${event.id} → provider ${svc.userId}`)
        } catch {}
      }
    } catch (e) {
      console.error('[DVM] Local delivery failed:', e)
    }
  })())

  return c.json({
    job_id: jobId,
    event_id: event.id,
    status: 'open',
    kind,
  }, 201)
})

// GET /api/dvm/jobs — 查看自己的任务列表
api.get('/dvm/jobs', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const role = c.req.query('role') // customer | provider
  const status = c.req.query('status') // comma-separated
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  const conditions = [eq(dvmJobs.userId, user.id)]
  if (role === 'customer' || role === 'provider') {
    conditions.push(eq(dvmJobs.role, role))
  }
  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length > 0) {
      conditions.push(inArray(dvmJobs.status, statuses))
    }
  }

  const jobs = await db
    .select()
    .from(dvmJobs)
    .where(and(...conditions))
    .orderBy(desc(dvmJobs.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({
    jobs: jobs.map(j => ({
      id: j.id,
      role: j.role,
      kind: j.kind,
      status: j.status,
      input: j.input,
      input_type: j.inputType,
      output: j.output,
      result: j.result,
      bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : null,
      customer_pubkey: j.customerPubkey,
      provider_pubkey: j.providerPubkey,
      request_event_id: j.requestEventId,
      result_event_id: j.resultEventId,
      params: j.params ? JSON.parse(j.params) : null,
      created_at: j.createdAt,
      updated_at: j.updatedAt,
    })),
    page,
    limit,
  })
})

// GET /api/dvm/jobs/:id — 任务详情（查看任意 job）
api.get('/dvm/jobs/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  // 先查自己名下的 job（包含 provider 视角）
  let job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id)))
    .limit(1)

  // 如果不是自己的，查 customer 的原始 job（公开需求）
  if (job.length === 0) {
    job = await db.select().from(dvmJobs)
      .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.role, 'customer')))
      .limit(1)
  }

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)

  const j = job[0]
  return c.json({
    id: j.id,
    role: j.role,
    kind: j.kind,
    status: j.status,
    input: j.input,
    input_type: j.inputType,
    output: j.output,
    result: j.result,
    bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : null,
    price_sats: j.priceMsats ? Math.floor(j.priceMsats / 1000) : null,
    customer_pubkey: j.customerPubkey,
    provider_pubkey: j.providerPubkey,
    request_event_id: j.requestEventId,
    result_event_id: j.resultEventId,
    params: j.params ? JSON.parse(j.params) : null,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  })
})

// POST /api/dvm/jobs/:id/accept — Provider: 接单（为自己创建 provider job）
api.post('/dvm/jobs/:id/accept', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  // 查 customer 的原始 job
  const customerJob = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (customerJob.length === 0) return c.json({ error: 'Job not found' }, 404)

  const cj = customerJob[0]
  if (cj.userId === user.id) return c.json({ error: 'Cannot accept your own job' }, 400)
  if (cj.status === 'cancelled') return c.json({ error: 'Job is cancelled' }, 400)
  if (cj.status === 'completed') return c.json({ error: 'Job is already completed' }, 400)

  // error 状态允许重新接单，重置为 open
  if (cj.status === 'error') {
    await db.update(dvmJobs)
      .set({ status: 'open', updatedAt: new Date() })
      .where(eq(dvmJobs.id, jobId))
  }

  // 检查是否已有活跃的 provider job（open/processing）
  const existing = await db.select({ id: dvmJobs.id, status: dvmJobs.status }).from(dvmJobs)
    .where(and(
      eq(dvmJobs.requestEventId, cj.requestEventId!),
      eq(dvmJobs.userId, user.id),
      eq(dvmJobs.role, 'provider'),
      inArray(dvmJobs.status, ['open', 'processing']),
    ))
    .limit(1)

  if (existing.length > 0) {
    return c.json({ job_id: existing[0].id, status: 'already_accepted' })
  }

  // 创建 provider job
  const providerJobId = generateId()
  const now = new Date()
  await db.insert(dvmJobs).values({
    id: providerJobId,
    userId: user.id,
    role: 'provider',
    kind: cj.kind,
    status: 'open',
    input: cj.input,
    inputType: cj.inputType,
    output: cj.output,
    bidMsats: cj.bidMsats,
    customerPubkey: cj.customerPubkey,
    requestEventId: cj.requestEventId,
    params: cj.params,
    createdAt: now,
    updatedAt: now,
  })

  return c.json({ job_id: providerJobId, status: 'accepted', kind: cj.kind })
})

// POST /api/dvm/jobs/:id/reject — Customer: 拒绝结果，重新开放接单
api.post('/dvm/jobs/:id/reject', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (job[0].status !== 'result_available') {
    return c.json({ error: `Cannot reject job with status: ${job[0].status}` }, 400)
  }

  // 重置 customer job 为 open
  await db.update(dvmJobs)
    .set({
      status: 'open',
      result: null,
      resultEventId: null,
      providerPubkey: null,
      priceMsats: null,
      updatedAt: new Date(),
    })
    .where(eq(dvmJobs.id, jobId))

  // 把对应的 provider job 标记为 rejected
  if (job[0].requestEventId) {
    await db.update(dvmJobs)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(
        eq(dvmJobs.requestEventId, job[0].requestEventId),
        eq(dvmJobs.role, 'provider'),
        inArray(dvmJobs.status, ['completed', 'result_available']),
      ))
  }

  // 重新同站直投：给注册了对应 Kind 的 Provider 创建新的 provider job（排除已被拒绝的）
  const cj = job[0]
  c.executionCtx.waitUntil((async () => {
    try {
      const activeServices = await db
        .select({ userId: dvmServices.userId, kinds: dvmServices.kinds })
        .from(dvmServices)
        .where(eq(dvmServices.active, 1))

      for (const svc of activeServices) {
        if (svc.userId === user.id) continue
        try {
          const svcKinds = JSON.parse(svc.kinds) as number[]
          if (!svcKinds.includes(cj.kind)) continue

          // 检查该 Provider 是否已有此 request 的 rejected 记录（不重复投递给已被拒绝的）
          // 但如果同一 Provider 想重新接单，accept 接口仍然可用
          const existing = await db.select({ id: dvmJobs.id }).from(dvmJobs)
            .where(and(
              eq(dvmJobs.requestEventId, cj.requestEventId!),
              eq(dvmJobs.userId, svc.userId),
              eq(dvmJobs.role, 'provider'),
              inArray(dvmJobs.status, ['open', 'processing']),
            ))
            .limit(1)
          if (existing.length > 0) continue

          await db.insert(dvmJobs).values({
            id: generateId(),
            userId: svc.userId,
            role: 'provider',
            kind: cj.kind,
            status: 'open',
            input: cj.input,
            inputType: cj.inputType,
            output: cj.output,
            bidMsats: cj.bidMsats,
            customerPubkey: cj.customerPubkey,
            requestEventId: cj.requestEventId,
            params: cj.params,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          console.log(`[DVM] Re-delivery after reject: job ${cj.requestEventId} → provider ${svc.userId}`)
        } catch {}
      }
    } catch (e) {
      console.error('[DVM] Re-delivery after reject failed:', e)
    }
  })())

  return c.json({ ok: true, status: 'open' })
})

// POST /api/dvm/jobs/:id/cancel — Customer: 取消任务
api.post('/dvm/jobs/:id/cancel', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (job[0].status === 'completed' || job[0].status === 'cancelled') {
    return c.json({ error: `Cannot cancel job with status: ${job[0].status}` }, 400)
  }

  await db.update(dvmJobs)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(dvmJobs.id, jobId))

  // Send Kind 5 deletion event for the request
  if (job[0].requestEventId && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 5,
          content: '',
          tags: [['e', job[0].requestEventId!]],
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[DVM] Failed to send deletion event:', e)
      }
    })())
  }

  return c.json({ ok: true, status: 'cancelled' })
})

// POST /api/dvm/services — Provider: 注册服务
api.post('/dvm/services', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    kinds?: number[]
    description?: string
    pricing?: { min_sats?: number; max_sats?: number }
  }

  if (!body.kinds || !Array.isArray(body.kinds) || body.kinds.length === 0) {
    return c.json({ error: 'kinds array is required' }, 400)
  }

  for (const k of body.kinds) {
    if (k < 5000 || k > 5999) {
      return c.json({ error: `Invalid kind ${k}: must be between 5000 and 5999` }, 400)
    }
  }

  const pricingMin = body.pricing?.min_sats ? body.pricing.min_sats * 1000 : null
  const pricingMax = body.pricing?.max_sats ? body.pricing.max_sats * 1000 : null

  // Build NIP-89 Handler Info (Kind 31990)
  const handlerEvent = await buildHandlerInfoEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    kinds: body.kinds,
    name: user.displayName || user.username,
    about: body.description,
    pricingMin: pricingMin || undefined,
    pricingMax: pricingMax || undefined,
  })

  const serviceId = generateId()
  const now = new Date()

  await db.insert(dvmServices).values({
    id: serviceId,
    userId: user.id,
    kinds: JSON.stringify(body.kinds),
    description: body.description || null,
    pricingMin,
    pricingMax,
    eventId: handlerEvent.id,
    active: 1,
    createdAt: now,
    updatedAt: now,
  })

  // Publish Handler Info to relay
  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [handlerEvent] }))
  }

  return c.json({
    service_id: serviceId,
    event_id: handlerEvent.id,
    kinds: body.kinds,
  }, 201)
})

// GET /api/dvm/services — Provider: 查看自己注册的服务
api.get('/dvm/services', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const services = await db.select().from(dvmServices)
    .where(eq(dvmServices.userId, user.id))
    .orderBy(desc(dvmServices.createdAt))

  return c.json({
    services: services.map(s => ({
      id: s.id,
      kinds: JSON.parse(s.kinds),
      description: s.description,
      pricing_min_sats: s.pricingMin ? Math.floor(s.pricingMin / 1000) : null,
      pricing_max_sats: s.pricingMax ? Math.floor(s.pricingMax / 1000) : null,
      active: !!s.active,
      created_at: s.createdAt,
    })),
  })
})

// DELETE /api/dvm/services/:id — Provider: 停用服务
api.delete('/dvm/services/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const serviceId = c.req.param('id')

  const svc = await db.select({ id: dvmServices.id }).from(dvmServices)
    .where(and(eq(dvmServices.id, serviceId), eq(dvmServices.userId, user.id)))
    .limit(1)

  if (svc.length === 0) return c.json({ error: 'Service not found' }, 404)

  await db.update(dvmServices)
    .set({ active: 0, updatedAt: new Date() })
    .where(eq(dvmServices.id, serviceId))

  return c.json({ ok: true })
})

// GET /api/dvm/inbox — Provider: 查看收到的 Job Request
api.get('/dvm/inbox', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const kindFilter = c.req.query('kind')
  const statusFilter = c.req.query('status') || 'open'
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  const conditions = [eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'provider')]
  if (kindFilter) {
    conditions.push(eq(dvmJobs.kind, parseInt(kindFilter)))
  }
  if (statusFilter) {
    const statuses = statusFilter.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length > 0) {
      conditions.push(inArray(dvmJobs.status, statuses))
    }
  }

  const jobs = await db
    .select()
    .from(dvmJobs)
    .where(and(...conditions))
    .orderBy(desc(dvmJobs.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({
    jobs: jobs.map(j => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      input: j.input,
      input_type: j.inputType,
      output: j.output,
      bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : null,
      customer_pubkey: j.customerPubkey,
      request_event_id: j.requestEventId,
      params: j.params ? JSON.parse(j.params) : null,
      created_at: j.createdAt,
    })),
    page,
    limit,
  })
})

// POST /api/dvm/jobs/:id/feedback — Provider: 发送状态更新
api.post('/dvm/jobs/:id/feedback', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'provider')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (!job[0].requestEventId || !job[0].customerPubkey) {
    return c.json({ error: 'Job missing request data' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    status?: 'processing' | 'error'
    content?: string
  }

  if (!body.status || !['processing', 'error'].includes(body.status)) {
    return c.json({ error: 'status must be "processing" or "error"' }, 400)
  }

  const feedbackEvent = await buildJobFeedbackEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    requestEventId: job[0].requestEventId!,
    customerPubkey: job[0].customerPubkey!,
    status: body.status,
    content: body.content,
  })

  await db.update(dvmJobs)
    .set({ status: body.status === 'error' ? 'error' : 'processing', updatedAt: new Date() })
    .where(eq(dvmJobs.id, jobId))

  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [feedbackEvent] }))
  }

  return c.json({ ok: true, event_id: feedbackEvent.id })
})

// POST /api/dvm/jobs/:id/result — Provider: 提交结果
api.post('/dvm/jobs/:id/result', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'provider')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (!job[0].requestEventId || !job[0].customerPubkey) {
    return c.json({ error: 'Job missing request data' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    content?: string
    amount_sats?: number
    bolt11?: string
  }

  if (!body.content) {
    return c.json({ error: 'content is required' }, 400)
  }

  const amountSats = body.amount_sats || 0
  const amountMsats = amountSats ? amountSats * 1000 : undefined

  // Provider can include their own bolt11 invoice for payment
  const bolt11 = body.bolt11 || undefined

  const resultEvent = await buildJobResultEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    requestKind: job[0].kind,
    requestEventId: job[0].requestEventId!,
    customerPubkey: job[0].customerPubkey!,
    content: body.content,
    amountMsats: amountMsats,
    bolt11,
  })

  // Update provider job
  await db.update(dvmJobs)
    .set({
      status: 'completed',
      result: body.content,
      resultEventId: resultEvent.id,
      eventId: resultEvent.id,
      priceMsats: amountMsats || null,
      bolt11: bolt11 || null,
      updatedAt: new Date(),
    })
    .where(eq(dvmJobs.id, jobId))

  // If customer is also on this site, update their job directly
  if (job[0].requestEventId) {
    const customerJob = await db.select({ id: dvmJobs.id }).from(dvmJobs)
      .where(and(
        eq(dvmJobs.requestEventId, job[0].requestEventId),
        eq(dvmJobs.role, 'customer'),
      ))
      .limit(1)

    if (customerJob.length > 0) {
      await db.update(dvmJobs)
        .set({
          status: 'result_available',
          result: body.content,
          providerPubkey: user.nostrPubkey,
          resultEventId: resultEvent.id,
          priceMsats: amountMsats || null,
          updatedAt: new Date(),
        })
        .where(eq(dvmJobs.id, customerJob[0].id))
    }
  }

  // Publish result to relay
  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [resultEvent] }))
  }

  return c.json({ ok: true, event_id: resultEvent.id }, 201)
})


// POST /api/dvm/jobs/:id/complete — Customer confirms result, pay provider via NWC
api.post('/dvm/jobs/:id/complete', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (job[0].status !== 'result_available') {
    return c.json({ error: `Cannot complete job with status: ${job[0].status}` }, 400)
  }

  const bidSats = job[0].bidMsats ? Math.floor(job[0].bidMsats / 1000) : 0
  const priceSats = job[0].priceMsats ? Math.floor(job[0].priceMsats / 1000) : 0
  const totalPaymentSats = priceSats > 0 ? Math.min(priceSats, bidSats || priceSats) : bidSats

  // Calculate platform fee
  const feePercent = parseFloat(c.env.PLATFORM_FEE_PERCENT || '0')
  const platformAddress = c.env.PLATFORM_LIGHTNING_ADDRESS || ''
  const feeSats = (feePercent > 0 && platformAddress) ? Math.max(1, Math.floor(totalPaymentSats * feePercent / 100)) : 0
  const providerSats = totalPaymentSats - feeSats

  // Payment via NWC if amount > 0
  let paymentResult: { preimage?: string; paid_sats?: number; fee_sats?: number } = {}

  if (totalPaymentSats > 0) {
    // Customer must have NWC enabled
    if (!user.nwcEnabled || !user.nwcEncrypted || !user.nwcIv || !c.env.NOSTR_MASTER_KEY) {
      return c.json({ error: 'NWC wallet not configured. Connect a wallet via PUT /api/me to pay for jobs.' }, 400)
    }

    const nwcUri = await decryptNwcUri(user.nwcEncrypted, user.nwcIv, c.env.NOSTR_MASTER_KEY)
    const nwcParsed = parseNwcUri(nwcUri)

    // Step 1: Pay platform fee
    if (feeSats > 0) {
      try {
        await resolveAndPayLightningAddress(nwcParsed, platformAddress, feeSats)
        console.log(`[DVM] Platform fee: ${feeSats} sats → ${platformAddress}`)
      } catch (e) {
        console.error('[DVM] Platform fee payment failed:', e)
        return c.json({
          error: 'Platform fee payment failed',
          detail: e instanceof Error ? e.message : 'Unknown error',
        }, 502)
      }
    }

    // Step 2: Pay provider
    if (job[0].bolt11) {
      try {
        const result = await nwcPayInvoice(nwcParsed, job[0].bolt11)
        paymentResult = { preimage: result.preimage, paid_sats: totalPaymentSats, fee_sats: feeSats }
      } catch (e) {
        return c.json({
          error: 'NWC payment failed',
          detail: e instanceof Error ? e.message : 'Unknown error',
        }, 502)
      }
    } else {
      let providerLightningAddress: string | null = null

      if (job[0].requestEventId) {
        const providerJob = await db.select({ userId: dvmJobs.userId }).from(dvmJobs)
          .where(and(
            eq(dvmJobs.requestEventId, job[0].requestEventId),
            eq(dvmJobs.role, 'provider'),
            eq(dvmJobs.status, 'completed'),
          ))
          .limit(1)
        if (providerJob.length > 0) {
          const providerUser = await db.select({ lightningAddress: users.lightningAddress }).from(users)
            .where(eq(users.id, providerJob[0].userId)).limit(1)
          if (providerUser.length > 0) providerLightningAddress = providerUser[0].lightningAddress
        }
      }
      if (!providerLightningAddress && job[0].providerPubkey) {
        const localUser = await db.select({ lightningAddress: users.lightningAddress }).from(users)
          .where(eq(users.nostrPubkey, job[0].providerPubkey)).limit(1)
        if (localUser.length > 0) providerLightningAddress = localUser[0].lightningAddress
      }

      if (!providerLightningAddress) {
        return c.json({
          error: 'Cannot pay: provider has no Lightning invoice or Lightning Address',
        }, 400)
      }

      try {
        const result = await resolveAndPayLightningAddress(nwcParsed, providerLightningAddress, providerSats)
        paymentResult = { preimage: result.preimage, paid_sats: totalPaymentSats, fee_sats: feeSats }
      } catch (e) {
        return c.json({
          error: 'NWC payment to Lightning Address failed',
          detail: e instanceof Error ? e.message : 'Unknown error',
        }, 502)
      }
    }
  }

  // Mark customer job as completed
  await db.update(dvmJobs)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(eq(dvmJobs.id, jobId))

  return c.json({
    ok: true,
    ...(paymentResult.paid_sats ? { paid_sats: paymentResult.paid_sats, provider_sats: providerSats, fee_sats: paymentResult.fee_sats } : {}),
  })
})


export default api
