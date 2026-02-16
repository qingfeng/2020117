import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// 用户表
export const users = sqliteTable('user', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  role: text('role'), // 'admin' = 超级管理员
  nostrPubkey: text('nostr_pubkey'),
  nostrPrivEncrypted: text('nostr_priv_encrypted'),
  nostrPrivIv: text('nostr_priv_iv'),
  nostrKeyVersion: integer('nostr_key_version').default(1),
  nostrSyncEnabled: integer('nostr_sync_enabled').default(0),
  nip05Enabled: integer('nip05_enabled').default(0),
  nwcEncrypted: text('nwc_encrypted'),
  nwcIv: text('nwc_iv'),
  nwcEnabled: integer('nwc_enabled').default(0),
  lightningAddress: text('lightning_address'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 认证方式表
export const authProviders = sqliteTable('auth_provider', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  providerType: text('provider_type').notNull(), // apikey | nostr
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  metadata: text('metadata'), // JSON
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 小组表
export const groups = sqliteTable('group', {
  id: text('id').primaryKey(),
  creatorId: text('creator_id').notNull().references(() => users.id),
  name: text('name').notNull().unique(),
  description: text('description'),
  tags: text('tags'),
  iconUrl: text('icon_url'),
  nostrPubkey: text('nostr_pubkey'),
  nostrPrivEncrypted: text('nostr_priv_encrypted'),
  nostrPrivIv: text('nostr_priv_iv'),
  nostrSyncEnabled: integer('nostr_sync_enabled').default(0),
  nostrCommunityEventId: text('nostr_community_event_id'),
  nostrLastPollAt: integer('nostr_last_poll_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 小组成员表
export const groupMembers = sqliteTable('group_member', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id),
  userId: text('user_id').notNull().references(() => users.id),
  joinReason: text('join_reason'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 话题表
export const topics = sqliteTable('topic', {
  id: text('id').primaryKey(),
  groupId: text('group_id').references(() => groups.id),
  userId: text('user_id').references(() => users.id),
  title: text('title').notNull(),
  content: text('content'),
  type: integer('type').default(0), // 0=话题 1=问题 2=投票
  images: text('images'), // JSON array
  nostrEventId: text('nostr_event_id'),
  nostrAuthorPubkey: text('nostr_author_pubkey'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 评论表
export const comments = sqliteTable('comment', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  userId: text('user_id').references(() => users.id),
  content: text('content').notNull(),
  replyToId: text('reply_to_id'),
  nostrEventId: text('nostr_event_id'),
  nostrAuthorPubkey: text('nostr_author_pubkey'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// 评论点赞表
export const commentLikes = sqliteTable('comment_like', {
  id: text('id').primaryKey(),
  commentId: text('comment_id').notNull().references(() => comments.id),
  userId: text('user_id').references(() => users.id),
  nostrAuthorPubkey: text('nostr_author_pubkey'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 评论转发表
export const commentReposts = sqliteTable('comment_repost', {
  id: text('id').primaryKey(),
  commentId: text('comment_id').notNull().references(() => comments.id),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 话题喜欢表
export const topicLikes = sqliteTable('topic_like', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  userId: text('user_id').references(() => users.id),
  nostrAuthorPubkey: text('nostr_author_pubkey'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 话题转发表
export const topicReposts = sqliteTable('topic_repost', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 举报表
export const reports = sqliteTable('report', {
  id: text('id').primaryKey(),
  reporterId: text('reporter_id').notNull().references(() => users.id),
  reportedUserId: text('reported_user_id').notNull().references(() => users.id),
  message: text('message'),
  imageUrl: text('image_url'),
  isRead: integer('is_read').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 站内提醒表
export const notifications = sqliteTable('notification', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  actorId: text('actor_id'),
  type: text('type').notNull(),
  topicId: text('topic_id'),
  commentId: text('comment_id'),
  isRead: integer('is_read').default(0).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  actorName: text('actor_name'),
  actorUrl: text('actor_url'),
  actorAvatarUrl: text('actor_avatar_url'),
  actorUri: text('actor_uri'),
  metadata: text('metadata'),
})

// 本地用户关注关系
export const userFollows = sqliteTable('user_follow', {
  id: text('id').primaryKey(),
  followerId: text('follower_id').notNull().references(() => users.id),
  followeeId: text('followee_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Nostr 关注表
export const nostrFollows = sqliteTable('nostr_follow', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  targetPubkey: text('target_pubkey').notNull(),
  targetNpub: text('target_npub'),
  targetDisplayName: text('target_display_name'),
  targetAvatarUrl: text('target_avatar_url'),
  lastPollAt: integer('last_poll_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Nostr 社区关注表
export const nostrCommunityFollows = sqliteTable('nostr_community_follow', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  communityPubkey: text('community_pubkey').notNull(),
  communityDTag: text('community_d_tag').notNull(),
  communityRelay: text('community_relay'),
  communityName: text('community_name'),
  localGroupId: text('local_group_id').references(() => groups.id),
  lastPollAt: integer('last_poll_at'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// DVM 任务表 (NIP-90)
export const dvmJobs = sqliteTable('dvm_job', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  role: text('role').notNull(), // 'customer' | 'provider'
  kind: integer('kind').notNull(),
  eventId: text('event_id'),
  status: text('status').notNull(),
  input: text('input'),
  inputType: text('input_type'),
  output: text('output'),
  result: text('result'),
  bidMsats: integer('bid_msats'),
  priceMsats: integer('price_msats'),
  customerPubkey: text('customer_pubkey'),
  providerPubkey: text('provider_pubkey'),
  requestEventId: text('request_event_id'),
  resultEventId: text('result_event_id'),
  params: text('params'),
  bolt11: text('bolt11'),
  paymentHash: text('payment_hash'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// DVM 服务注册表 (NIP-89)
export const dvmServices = sqliteTable('dvm_service', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id).unique(),
  kinds: text('kinds').notNull(),
  description: text('description'),
  pricingMin: integer('pricing_min'),
  pricingMax: integer('pricing_max'),
  eventId: text('event_id'),
  active: integer('active').default(1),
  jobsCompleted: integer('jobs_completed').default(0),
  jobsRejected: integer('jobs_rejected').default(0),
  jobsCancelled: integer('jobs_cancelled').default(0),
  totalEarnedMsats: integer('total_earned_msats').default(0),
  totalZapReceived: integer('total_zap_received').default(0),
  avgResponseMs: integer('avg_response_ms'),
  lastJobAt: integer('last_job_at', { mode: 'timestamp' }),
  directRequestEnabled: integer('direct_request_enabled').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

// Nostr 举报表 (NIP-56 Kind 1984)
export const nostrReports = sqliteTable('nostr_report', {
  id: text('id').primaryKey(),
  nostrEventId: text('nostr_event_id').unique(),
  reporterPubkey: text('reporter_pubkey').notNull(),
  targetPubkey: text('target_pubkey').notNull(),
  targetEventId: text('target_event_id'),
  reportType: text('report_type').notNull(), // nudity|malware|profanity|illegal|spam|impersonation|other
  content: text('content'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 类型导出
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type AuthProvider = typeof authProviders.$inferSelect
export type Group = typeof groups.$inferSelect
export type GroupMember = typeof groupMembers.$inferSelect
export type Topic = typeof topics.$inferSelect
export type Comment = typeof comments.$inferSelect
export type CommentLike = typeof commentLikes.$inferSelect
export type CommentRepost = typeof commentReposts.$inferSelect
export type TopicLike = typeof topicLikes.$inferSelect
export type Report = typeof reports.$inferSelect
export type Notification = typeof notifications.$inferSelect
export type TopicRepost = typeof topicReposts.$inferSelect
export type UserFollow = typeof userFollows.$inferSelect
export type NostrFollow = typeof nostrFollows.$inferSelect
export type NostrCommunityFollow = typeof nostrCommunityFollows.$inferSelect
export type DvmJob = typeof dvmJobs.$inferSelect
export type DvmService = typeof dvmServices.$inferSelect
export type NostrReport = typeof nostrReports.$inferSelect
