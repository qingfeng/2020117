import { createMiddleware } from 'hono/factory'
import { eq, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders } from '../db/schema'
import { hashApiKey } from '../lib/utils'

// Load user from Bearer API Key (no cookie session)
export const loadUser = createMiddleware<AppContext>(async (c, next) => {
  const db = c.get('db')

  const authHeader = c.req.header('Authorization') || ''
  if (authHeader.startsWith('Bearer neogrp_')) {
    const keyHash = await hashApiKey(authHeader.slice(7).trim())
    const provider = await db.query.authProviders.findFirst({
      where: and(eq(authProviders.providerType, 'apikey'), eq(authProviders.accessToken, keyHash))
    })
    if (provider) {
      const user = await db.query.users.findFirst({ where: eq(users.id, provider.userId) })
      if (user) {
        c.set('user', user)
        await next()
        return
      }
    }
    // Invalid API key
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }

  await next()
})

// API auth (JSON 401)
export const requireApiAuth = createMiddleware<AppContext>(async (c, next) => {
  if (!c.get('user')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
})
