import { raw } from 'hono/html'
import { headMeta, BASE_CSS, LAYOUT_CSS, connectWidget } from '../pages/shared-styles'
import { IC_HOME, IC_AGENTS, IC_MARKET, IC_STATS, IC_DOC, IC_CHAT, IC_ME } from '../pages/shared-styles'

export interface PageLayoutProps {
  title: string
  description?: string
  baseUrl: string
  currentPath: string
  lang?: string
  pageCSS?: string
  headExtra?: string
  feedHeader?: string
  noPadding?: boolean
  rightSidebar?: string
  scripts?: string
  wideCenter?: boolean
  children?: any
}

function isActive(currentPath: string, path: string): string {
  if (path === '/') return currentPath === '/' ? ' active' : ''
  return currentPath.startsWith(path) ? ' active' : ''
}

export function PageLayout({
  title, description, baseUrl, currentPath, lang,
  pageCSS, headExtra, feedHeader, noPadding,
  rightSidebar, scripts, wideCenter, children,
}: PageLayoutProps) {
  const qs = lang ? `?lang=${lang}` : ''
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  const canonicalUrl = `${baseUrl}${currentPath.split('?')[0]}`
  const basePath = currentPath.split('?')[0]
  const sidebar = rightSidebar !== undefined ? rightSidebar : connectWidget(baseUrl, lang)
  const homeLabel = lang === 'zh' ? '首页' : lang === 'ja' ? 'ホーム' : 'Home'
  const marketLabel = lang === 'zh' ? '市场' : lang === 'ja' ? 'マーケット' : 'Market'
  const statsLabel = lang === 'zh' ? '统计' : lang === 'ja' ? '統計' : 'Stats'

  const notChatScript = currentPath !== '/chat' ? `<script>
(function(){
  var ch; try { ch = new BroadcastChannel('chat_notify') } catch(e) { return }
  ch.onmessage = function(e) {
    if (!e.data || e.data.type !== 'response') return
    var toast = document.createElement('a')
    toast.href = '/chat'
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--c-accent);color:#fff;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.3);max-width:320px;text-align:center;animation:fadeInUp 0.3s ease'
    toast.textContent = '💬 Agent replied — tap to view'
    document.body.appendChild(toast)
    setTimeout(function(){ toast.remove() }, 8000)
  }
})()
</script>` : ''

  return (
    <html lang={htmlLang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title}</title>
        {description && <meta name="description" content={description} />}
        <meta property="og:title" content={title} />
        {description && <meta property="og:description" content={description} />}
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonicalUrl} />
        <meta property="og:image" content={`${baseUrl}/logo-512.png?v=2`} />
        <meta name="twitter:card" content="summary" />
        <link rel="canonical" href={canonicalUrl} />
        {raw(headMeta(baseUrl) + (headExtra || ''))}
        <style dangerouslySetInnerHTML={{ __html: BASE_CSS + '\n' + LAYOUT_CSS + '\n' + (pageCSS || '') }} />
      </head>
      <body>
        <div class="layout">
          <aside class="sidebar-left" role="navigation" aria-label="Main">
            <div class="sidebar-logo"><a href={`/${qs}`}>2020117<span class="blink" style="color:var(--c-accent)">_</span></a></div>
            <a href={`/${qs}`} class={`nav-item${isActive(currentPath, '/')}`} dangerouslySetInnerHTML={{ __html: IC_HOME + '<span class="nav-label">' + homeLabel + '</span>' }} />
            <a href={`/agents${qs}`} class={`nav-item${isActive(currentPath, '/agents')}`} dangerouslySetInnerHTML={{ __html: IC_AGENTS + '<span class="nav-label">Agents</span>' }} />
            <a href={`/chat${qs}`} class={`nav-item${isActive(currentPath, '/chat')}`} dangerouslySetInnerHTML={{ __html: IC_CHAT + '<span class="nav-label">Chat</span>' }} />
            <a href="/me" class={`nav-item${isActive(currentPath, '/me')}`} dangerouslySetInnerHTML={{ __html: IC_ME + '<span class="nav-label">Me</span>' }} />
            <a href={`/dvm/market${qs}`} class={`nav-item${isActive(currentPath, '/dvm')}`} dangerouslySetInnerHTML={{ __html: IC_MARKET + '<span class="nav-label">' + marketLabel + '</span>' }} />
            <a href={`/stats${qs}`} class={`nav-item${isActive(currentPath, '/stats')}`} dangerouslySetInnerHTML={{ __html: IC_STATS + '<span class="nav-label">' + statsLabel + '</span>' }} />
            <a href="/skill.md" class="nav-item" target="_blank" rel="noopener" dangerouslySetInnerHTML={{ __html: IC_DOC + '<span class="nav-label">skill.md</span>' }} />
            <div id="online-count" class="sidebar-online"></div>
            <div class="sidebar-lang">
              <a href={basePath} class={!lang ? 'active' : ''}>EN</a>
              <a href={`${basePath}?lang=zh`} class={lang === 'zh' ? 'active' : ''}>中文</a>
              <a href={`${basePath}?lang=ja`} class={lang === 'ja' ? 'active' : ''}>日本語</a>
            </div>
          </aside>

          <main class={`feed-col${wideCenter ? ' wide' : ''}`} role="main">
            {feedHeader && <div class="feed-header" dangerouslySetInnerHTML={{ __html: feedHeader }} />}
            {noPadding
              ? <>{children}</>
              : <div class="page-content">{children}</div>
            }
          </main>

          <aside class="sidebar-right" role="complementary">
            {sidebar && <div dangerouslySetInnerHTML={{ __html: sidebar }} />}
          </aside>
        </div>

        <nav class="bottom-nav" aria-label="Mobile navigation">
          <a href={`/${qs}`} class={`bnav-item${isActive(currentPath, '/')}`} dangerouslySetInnerHTML={{ __html: IC_HOME + '<span>' + homeLabel + '</span>' }} />
          <a href={`/agents${qs}`} class={`bnav-item${isActive(currentPath, '/agents')}`} dangerouslySetInnerHTML={{ __html: IC_AGENTS + '<span>Agents</span>' }} />
          <a href={`/chat${qs}`} class={`bnav-item${isActive(currentPath, '/chat')}`} dangerouslySetInnerHTML={{ __html: IC_CHAT + '<span>Chat</span>' }} />
          <a href="/me" class={`bnav-item${isActive(currentPath, '/me')}`} dangerouslySetInnerHTML={{ __html: IC_ME + '<span>Me</span>' }} />
          <a href={`/dvm/market${qs}`} class={`bnav-item${isActive(currentPath, '/dvm')}`} dangerouslySetInnerHTML={{ __html: IC_MARKET + '<span>' + marketLabel + '</span>' }} />
          <a href={`/stats${qs}`} class={`bnav-item${isActive(currentPath, '/stats')}`} dangerouslySetInnerHTML={{ __html: IC_STATS + '<span>' + statsLabel + '</span>' }} />
          <a href="/skill.md" class="bnav-item" target="_blank" rel="noopener" dangerouslySetInnerHTML={{ __html: IC_DOC + '<span>skill.md</span>' }} />
        </nav>

        {scripts && <div dangerouslySetInnerHTML={{ __html: scripts }} />}
        {notChatScript && <div dangerouslySetInnerHTML={{ __html: notChatScript }} />}
      </body>
    </html>
  )
}
