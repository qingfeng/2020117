import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import { users } from '../db/schema'

export function generateId(): string {
  return nanoid(12)
}

// API Key generation: neogrp_ + 32-char hex (128-bit entropy)
export async function generateApiKey(): Promise<{ key: string; hash: string; keyId: string }> {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  const key = `neogrp_${hex}`
  const hash = await hashApiKey(key)
  const keyId = nanoid(12)
  return { key, hash, keyId }
}

// SHA-256 hash (for storage, raw key never persisted)
export async function hashApiKey(key: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function isSuperAdmin(user: { role?: string | null } | null): boolean {
  return user?.role === 'admin'
}

export function mastodonUsername(username: string, domain: string): string {
  void domain
  return username
}

const MAX_USERNAME_ATTEMPTS = 20

function random4Digits(): string {
  const n = Math.floor(Math.random() * 10000)
  return n.toString().padStart(4, '0')
}

export async function ensureUniqueUsername(db: Database, base: string): Promise<string> {
  let candidate = base
  for (let i = 0; i < MAX_USERNAME_ATTEMPTS; i++) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1)

    if (existing.length === 0) return candidate
    candidate = `${base}${random4Digits()}`
  }

  throw new Error(`Failed to generate unique username for ${base}`)
}

export function now(): Date {
  return new Date()
}

export function parseJson<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str) as T
  } catch {
    return fallback
  }
}

export function toJson(obj: unknown): string {
  return JSON.stringify(obj)
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?(p|div|h[1-6]|li|blockquote|pre)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function sanitizeHtml(html: string): string {
  if (!html) return ''

  const allowedTags = new Set([
    'p', 'br', 'a', 'span', 'strong', 'em', 'b', 'i', 'u',
    'ul', 'ol', 'li', 'img', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'div'
  ])

  let result = html.replace(/<(\/?)([\w-]+)([^>]*)>/gi, (match, slash, tagName, attrs) => {
    const tag = tagName.toLowerCase()

    if (!allowedTags.has(tag)) {
      return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    if (slash === '/') {
      return `</${tag}>`
    }

    let safeAttrs = ''

    attrs = attrs.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    attrs = attrs.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '')

    if (tag === 'a') {
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i)
      if (hrefMatch && !hrefMatch[1].match(/^(javascript|data|vbscript):/i)) {
        safeAttrs = ` href="${escapeAttr(hrefMatch[1])}" target="_blank" rel="noopener nofollow"`
      }
    } else if (tag === 'img') {
      const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i)
      const altMatch = attrs.match(/alt\s*=\s*["']([^"']*?)["']/i)
      const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/i)
      if (srcMatch && !srcMatch[1].match(/^(javascript|data|vbscript):/i)) {
        safeAttrs = ` src="${escapeAttr(srcMatch[1])}"`
        if (altMatch) {
          safeAttrs += ` alt="${escapeAttr(altMatch[1])}"`
        }
        if (classMatch) {
          safeAttrs += ` class="${escapeAttr(classMatch[1])}"`
        }
      } else {
        return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }
    } else if (tag === 'span' || tag === 'div') {
      const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/i)
      if (classMatch) {
        safeAttrs += ` class="${escapeAttr(classMatch[1])}"`
      }
    }

    return `<${tag}${safeAttrs}>`
  })

  return result
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength).trim() + '...'
}
