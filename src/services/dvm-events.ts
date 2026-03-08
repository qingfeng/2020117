import type { Bindings } from '../types'
import { type NostrEvent, buildSignedEvent } from './nostr'

// --- Event Builders ---

export async function buildJobRequestEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  kind: number
  input: string
  inputType: string
  output?: string
  bidMsats?: number
  extraParams?: Record<string, unknown>
  relays?: string[]
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['i', params.input, params.inputType],
  ]
  if (params.output) {
    tags.push(['output', params.output])
  }
  if (params.bidMsats) {
    tags.push(['bid', String(params.bidMsats)])
  }
  if (params.relays && params.relays.length > 0) {
    tags.push(['relays', ...params.relays])
  }
  if (params.extraParams) {
    for (const [key, value] of Object.entries(params.extraParams)) {
      tags.push(['param', key, typeof value === 'string' ? value : JSON.stringify(value)])
    }
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: params.kind,
    content: '',
    tags,
  })
}

export async function buildJobResultEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  requestKind: number
  requestEventId: string
  customerPubkey: string
  content: string
  amountMsats?: number
  bolt11?: string
}): Promise<NostrEvent> {
  const resultKind = params.requestKind + 1000
  const tags: string[][] = [
    ['e', params.requestEventId],
    ['p', params.customerPubkey],
  ]
  if (params.amountMsats) {
    const amountTag = ['amount', String(params.amountMsats)]
    if (params.bolt11) amountTag.push(params.bolt11)
    tags.push(amountTag)
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: resultKind,
    content: params.content,
    tags,
  })
}

export async function buildJobFeedbackEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  requestEventId: string
  customerPubkey: string
  status: 'processing' | 'success' | 'error' | 'payment-required'
  content?: string
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['status', params.status],
    ['e', params.requestEventId],
    ['p', params.customerPubkey],
  ]

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 7000,
    content: params.content || '',
    tags,
  })
}

export async function buildHandlerInfoEvents(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  kinds: number[]
  name: string
  picture?: string
  about?: string
  pricingMin?: number
  pricingMax?: number
  userId: string
  reputation?: Record<string, unknown>
  models?: string[]
  skill?: Record<string, unknown>
}): Promise<NostrEvent[]> {
  const content = JSON.stringify({
    name: params.name,
    ...(params.picture ? { picture: params.picture } : {}),
    about: params.about || '',
    ...(params.pricingMin || params.pricingMax ? {
      pricing: {
        unit: 'msats',
        ...(params.pricingMin ? { min: params.pricingMin } : {}),
        ...(params.pricingMax ? { max: params.pricingMax } : {}),
      },
    } : {}),
    ...(params.reputation ? { reputation: params.reputation } : {}),
    ...(params.models && params.models.length > 0 ? { models: params.models } : {}),
    ...(params.skill ? { skill: params.skill } : {}),
  })

  // One event per kind (matches NIP-89 convention used by other DVMs)
  const events: NostrEvent[] = []
  for (const k of params.kinds) {
    const event = await buildSignedEvent({
      privEncrypted: params.privEncrypted,
      iv: params.iv,
      masterKey: params.masterKey,
      kind: 31990,
      content,
      tags: [
        ['d', `neogroup-dvm-${params.userId}-${k}`],
        ['k', String(k)],
      ],
    })
    events.push(event)
  }
  return events
}

// --- Kind 30382: DVM Trust Declaration (NIP-85 Trusted Assertions) ---

export async function buildDvmTrustEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  targetPubkey: string
}): Promise<NostrEvent> {
  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 30382,
    content: '',
    tags: [
      ['d', params.targetPubkey],
      ['p', params.targetPubkey],
      ['assertion', 'trusted_dvm', '1'],
    ],
  })
}

// --- Kind 30333: Agent Heartbeat ---

export async function buildHeartbeatEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  pubkey: string
  capacity?: number
  kinds?: number[]
  pricing?: Record<string, number>
  models?: string[]
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['d', params.pubkey],
    ['status', 'online'],
  ]
  if (params.capacity !== undefined) {
    tags.push(['capacity', String(params.capacity)])
  }
  if (params.kinds && params.kinds.length > 0) {
    tags.push(['kinds', params.kinds.join(',')])
  }
  if (params.pricing && Object.keys(params.pricing).length > 0) {
    const priceStr = Object.entries(params.pricing).map(([k, v]) => `${k}:${v}`).join(',')
    tags.push(['price', priceStr])
  }
  if (params.models && params.models.length > 0) {
    tags.push(['models', params.models.join(',')])
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 30333,
    content: '',
    tags,
  })
}

// --- Kind 31117: Job Review ---

export async function buildJobReviewEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  jobEventId: string
  targetPubkey: string
  rating: number
  role: string
  jobKind: number
  content?: string
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['d', params.jobEventId],
    ['p', params.targetPubkey],
    ['rating', String(params.rating)],
    ['role', params.role],
    ['kind', String(params.jobKind)],
  ]

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 31117,
    content: params.content || '',
    tags,
  })
}

// --- Kind 21117: Escrow Result ---

export async function buildEscrowResultEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  customerPubkey: string
  jobEventId: string
  encryptedPayload: string
  hash: string
  preview?: string
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['p', params.customerPubkey],
    ['e', params.jobEventId],
    ['hash', params.hash],
  ]
  if (params.preview) {
    tags.push(['preview', params.preview])
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 21117,
    content: params.encryptedPayload,
    tags,
  })
}

// --- Kind 5117: Workflow Chain ---

export async function buildWorkflowEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  description: string
  input: string
  inputType: string
  steps: { kind: number; provider?: string; description?: string }[]
  bidMsats?: number
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['i', params.input, params.inputType],
  ]
  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i]
    tags.push(['step', String(i), String(step.kind), step.provider || '', step.description || ''])
  }
  if (params.bidMsats) {
    tags.push(['bid', String(params.bidMsats)])
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 5117,
    content: params.description,
    tags,
  })
}

// --- Kind 5118: Agent Swarm ---

export async function buildSwarmEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  content: string
  input: string
  inputType: string
  maxProviders: number
  judge?: string
  bidMsats?: number
  kind: number
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['i', params.input, params.inputType],
    ['swarm', String(params.maxProviders)],
    ['judge', params.judge || 'customer'],
  ]
  if (params.bidMsats) {
    tags.push(['bid', String(params.bidMsats)])
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: params.kind,
    content: params.content,
    tags,
  })
}

// --- Kind 30311: Peer Reputation Endorsement ---

export async function buildReputationEndorsementEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  targetPubkey: string
  rating: number
  comment?: string
  trusted?: boolean
  context?: { jobs_together: number; kinds: number[]; last_job_at: number }
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['d', params.targetPubkey],
    ['p', params.targetPubkey],
    ['rating', String(params.rating)],
  ]
  if (params.context?.kinds) {
    for (const k of params.context.kinds) {
      tags.push(['k', String(k)])
    }
  }

  const content: Record<string, unknown> = {
    rating: params.rating,
  }
  if (params.comment) content.comment = params.comment
  if (params.trusted !== undefined) content.trusted = params.trusted
  if (params.context) content.context = params.context

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 30311,
    content: JSON.stringify(content),
    tags,
  })
}
