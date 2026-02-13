import type { Database } from '../db'
import { notifications } from '../db/schema'
import { generateId } from './utils'

export async function createNotification(
  db: Database,
  data: {
    userId: string
    actorId?: string  // optional for remote actors
    type: string
    topicId?: string
    commentId?: string
    actorName?: string
    actorUrl?: string
    actorAvatarUrl?: string
    actorUri?: string  // AP actor URI for remote users
    metadata?: string
  }
): Promise<void> {
  // Don't notify yourself (only check if actorId is a local user ID)
  if (data.actorId && data.userId === data.actorId) return
  await db.insert(notifications).values({
    id: generateId(),
    userId: data.userId,
    actorId: data.actorId || null,
    type: data.type,
    topicId: data.topicId || null,
    commentId: data.commentId || null,
    actorName: data.actorName || null,
    actorUrl: data.actorUrl || null,
    actorAvatarUrl: data.actorAvatarUrl || null,
    actorUri: data.actorUri || null,
    metadata: data.metadata || null,
    createdAt: new Date(),
  })
}
