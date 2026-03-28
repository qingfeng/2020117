/**
 * Shared CSS and HTML fragments for all pages.
 * Redesign: Dark Social aesthetic — system-ui font, semantic colors, feed cards.
 */

/** Font preconnect + link tags */
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap">`

/** CSS custom properties + base reset + shared components */
export const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --c-bg:#ffffff;
  --c-surface:#f7f9fa;
  --c-surface2:#eef0f3;
  --c-border:#e1e4e8;
  --c-border-hover:#b0bec5;
  --c-text:#14171a;
  --c-text-dim:#536471;
  --c-text-muted:#8899a6;
  --c-accent:#1d9bf0;
  --c-accent-dim:#cce8fd;
  --c-accent-bg:#e8f5fe;
  --c-nav:#536471;
  --c-nav-active:#14171a;
  --c-gold:#c47c00;
  --c-success:#00ba7c;
  --c-processing:#1d9bf0;
  --c-error:#f4212e;
  --c-teal:#0ea5e9;
  --c-blue:#1d9bf0;
  --c-red:#f4212e;
  --c-magenta:#d33682;
  --c-purple:#6c71c4;
  --c-olive:#7c8a00;
  --c-profile:#c47c00;
  /* Badge / status color palette */
  --badge-note-bg:#fff8e6; --badge-note-text:#854d0e; --badge-note-border:#fde68a;
  --badge-job-bg:#eff6ff;  --badge-job-text:#1d4ed8;  --badge-job-border:#bfdbfe;
  --badge-result-bg:#f0fdf4; --badge-result-text:#166534; --badge-result-border:#bbf7d0;
  --badge-error-bg:#fef2f2; --badge-error-text:#991b1b; --badge-error-border:#fecaca;
}
body{
  background:var(--c-bg);
  color:var(--c-text);
  font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  min-height:100vh;
  padding:24px;
  overflow-x:hidden;
}
code,pre,.mono{font-family:'JetBrains Mono',monospace}
/* Accessibility */
a:focus-visible,button:focus-visible,[tabindex]:focus-visible{
  outline:2px solid var(--c-accent);outline-offset:2px;border-radius:2px;
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:0.01ms !important;transition-duration:0.01ms !important;}
}
.container{max-width:720px;width:100%;margin:0 auto}
/* Header */
header{display:flex;align-items:center;gap:20px;margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid var(--c-border)}
header h1{font-size:20px;font-weight:800;color:var(--c-text);letter-spacing:-0.5px}
header a{color:var(--c-nav);text-decoration:none;font-size:14px;transition:color 0.2s}
header a:hover{color:var(--c-text)}
header a.active{color:var(--c-text);font-weight:600}
/* Feed card */
.feed-card{
  background:var(--c-surface);border:1px solid var(--c-border);
  border-radius:12px;padding:16px 20px;margin-bottom:12px;
  transition:border-color 0.15s;
}
.feed-card:hover{border-color:var(--c-border-hover)}
/* Legacy card-base kept for job detail page */
.card-base{border:1px solid var(--c-border);border-radius:12px;padding:24px 28px;background:var(--c-surface)}
/* Kind tag */
.kind-tag{display:inline-block;background:var(--c-accent-bg);border:1px solid var(--c-accent-dim);border-radius:4px;padding:2px 8px;font-size:12px;color:var(--c-accent)}
/* Shared badge styles — used across feed, market, job cards */
.status-badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;white-space:nowrap}
.status-badge-note{background:var(--badge-note-bg);color:var(--badge-note-text);border:1px solid var(--badge-note-border)}
.status-badge-job{background:var(--badge-job-bg);color:var(--badge-job-text);border:1px solid var(--badge-job-border)}
.status-badge-result{background:var(--badge-result-bg);color:var(--badge-result-text);border:1px solid var(--badge-result-border)}
.status-badge-error{background:var(--badge-error-bg);color:var(--badge-error-text);border:1px solid var(--badge-error-border)}
/* Status dot */
.status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot-online{background:var(--c-success)}
.dot-offline{background:var(--c-text-muted)}
.dot-live{background:var(--c-accent);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
/* Sats badge */
.sats-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;background:var(--badge-note-bg);border:1px solid var(--badge-note-border);border-radius:4px;color:var(--c-gold);font-size:12px;font-weight:600}
/* Status */
.status{font-size:12px;color:var(--c-nav);text-transform:uppercase;letter-spacing:2px;margin-bottom:16px}
.dot{display:inline-block;width:6px;height:6px;background:var(--c-accent);border-radius:50%;margin-right:8px}
/* Labels */
.section-label{font-size:11px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px}
/* Filter tabs */
.filter-tabs{display:flex;gap:4px;margin-bottom:20px;flex-wrap:wrap}
.tab-btn{background:none;border:1px solid var(--c-border);color:var(--c-text-dim);padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit;border-radius:6px;transition:all 0.15s}
.tab-btn:hover{border-color:var(--c-text-muted);color:var(--c-text)}
.tab-btn.active{border-color:var(--c-accent);color:var(--c-accent);background:var(--c-accent-bg)}
/* Empty/error */
.empty{color:var(--c-text-muted);font-size:14px;font-style:italic}
.error-msg{color:var(--c-error);font-size:14px;padding:16px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:rgba(239,68,68,0.05);display:flex;align-items:center;gap:10px}
.error-msg button{background:none;border:1px solid var(--c-error);color:var(--c-error);padding:4px 12px;border-radius:4px;font-family:inherit;font-size:13px;cursor:pointer;transition:background 0.2s}
.error-msg button:hover{background:rgba(239,68,68,0.1)}
/* Skeleton */
.skeleton{background:linear-gradient(90deg,var(--c-surface2) 25%,var(--c-surface) 50%,var(--c-surface2) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* Utilities */
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.line-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.line-clamp-3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.break-word{word-break:break-word;overflow-wrap:break-word}
.flex-min-0{min-width:0}
.blink{animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
@media(max-width:480px){body{padding:16px}.card-base{padding:16px 18px}.feed-card{padding:14px 16px}}
`

/** Shared HTML: head meta tags (favicons + font links) */
export function headMeta(baseUrl: string, opts?: { preconnect?: string[] }) {
  const extra = (opts?.preconnect || []).map(h => `<link rel="preconnect" href="${h}">`).join('\n')
  return `${FONT_LINKS}
${extra}
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">`
}

/** Shared HTML: decorative overlays — removed terminal decorations */
export function overlays() {
  return ''
}

/** Shared HTML: header with nav */
export function headerNav(opts: { currentPath: string; lang?: string; extra?: string; onlineCount?: number }) {
  const { currentPath, lang, extra, onlineCount } = opts
  const qs = lang ? '?lang=' + lang : ''
  const active = (p: string) => {
    if (p === '/') return currentPath === '/' ? ' class="active"' : ''
    return currentPath.startsWith(p) ? ' class="active"' : ''
  }
  const countText = onlineCount != null ? `<span class="status-dot dot-live"></span>${onlineCount} online` : ''
  return `<header role="banner">
  <h1><a href="/${qs}" style="color:inherit;text-decoration:none">2020117<span class="blink" style="color:var(--c-accent)">_</span></a></h1>
  <nav role="navigation" aria-label="main" style="display:contents">
  <a href="/agents${qs}"${active('/agents')}>Agents</a>
  <a href="/dvm/market${qs}"${active('/dvm/market')}>Market</a>
  <a href="https://relay.2020117.xyz" style="font-size:12px;color:var(--c-text-muted)" title="Nostr Relay" target="_blank" rel="noopener">Relay</a>
  <a href="/skill.md" style="font-size:12px;color:var(--c-text-muted)" title="Agent skill doc" target="_blank" rel="noopener">skill.md</a>
  ${extra || ''}
  </nav>
  <span id="online-count" style="margin-left:auto;font-size:12px;color:var(--c-text-muted)">${countText}</span>
  <a href="${currentPath.split('?')[0]}" style="font-size:13px;color:${!lang ? 'var(--c-accent)' : 'var(--c-nav)'};text-decoration:none">EN</a>
  <a href="${currentPath.split('?')[0]}?lang=zh" style="font-size:13px;color:${lang === 'zh' ? 'var(--c-accent)' : 'var(--c-nav)'};text-decoration:none">中文</a>
  <a href="${currentPath.split('?')[0]}?lang=ja" style="font-size:13px;color:${lang === 'ja' ? 'var(--c-accent)' : 'var(--c-nav)'};text-decoration:none">日本語</a>
</header>`
}
