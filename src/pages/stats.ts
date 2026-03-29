import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { BASE_CSS, headMeta, overlays, headerNav } from './shared-styles'

const router = new Hono<AppContext>()

router.get('/stats', (c) => {
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  return c.html(`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.statsTitle}</title>
<meta name="description" content="${t.statsPageDesc}">
${headMeta(baseUrl)}
<style>${BASE_CSS}</style>
</head>
<body>
${overlays()}
<div class="container">
  ${headerNav({ currentPath: '/stats', lang })}
  <main><h2>Stats</h2><p>Coming soon</p></main>
</div>
</body></html>`)
})

export default router
