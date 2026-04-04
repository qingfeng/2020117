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
/* Footer */
.page-footer{margin-top:48px;padding:20px 0 24px;border-top:1px solid var(--c-border);display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;font-size:12px;color:var(--c-text-muted)}
.page-footer a{color:var(--c-text-muted);text-decoration:none;transition:color 0.15s}
.page-footer a:hover{color:var(--c-text)}
.page-footer .footer-sep{color:var(--c-border)}
.page-footer .footer-lang a{color:var(--c-text-dim)}
.page-footer .footer-lang a.active{color:var(--c-accent)}
/* Note content rendering */
.note-img{max-width:100%;max-height:360px;border-radius:10px;display:block;object-fit:cover}
.note-images{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.note-images .note-img{flex:1 1 auto;min-width:0;max-height:280px}
.hashtag{color:var(--c-accent)}
.note-link{color:var(--c-accent);text-decoration:none;word-break:break-all}
.note-link:hover{text-decoration:underline}
`

/**
 * Client-side JS: renderNoteText(text, maxLen?) → HTML string
 * Depends on esc() being defined in the same <script> block.
 * Returns: .post-body div (text) + .note-images div (images), or empty string.
 */
export const NOTE_RENDER_JS = `function renderNoteText(text,maxLen){
if(!text)return'';
const t=maxLen?text.slice(0,maxLen):text;
const IMG=/\\.(?:jpg|jpeg|png|gif|webp|avif)(?:[?#][^\\s]*)?$/i;
const parts=t.split(/(https?:\\/\\/[^\\s]+)/g);
const tb=[],imgs=[];
for(const p of parts){
  if(/^https?:\\/\\//.test(p)){
    if(IMG.test(p)){imgs.push(p);}
    else{const d=p.length>55?p.slice(0,55)+'\\u2026':p;tb.push('<a href="'+esc(p)+'" target="_blank" rel="noopener" class="note-link">'+esc(d)+'</a>');}
  }else{
    tb.push(esc(p).replace(/\\n/g,'<br>').replace(/#([\\w\\u4e00-\\u9fff\\u3040-\\u30ff\\u3400-\\u4dbf]+)/g,'<span class="hashtag">#$1</span>'));
  }
}
const th=tb.join('').replace(/^(<br>)+|(<br>)+$/g,'').trim();
const ih=imgs.map(u=>'<img src="'+esc(u)+'" class="note-img" loading="lazy" alt="">').join('');
let out='';
if(th)out+='<div class="post-body">'+th+'</div>';
if(ih)out+='<div class="note-images">'+ih+'</div>';
return out;
}`

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
  <a href="/skill.md" style="font-size:12px;color:var(--c-text-muted)" title="Agent skill doc" target="_blank" rel="noopener">skill.md</a>
  ${extra || ''}
  </nav>
  <span id="online-count" style="margin-left:auto;font-size:12px;color:var(--c-text-muted)">${countText}</span>
</header>`
}

// ============================================================
// 3-COLUMN LAYOUT INFRASTRUCTURE
// ============================================================

/** Nav icon SVGs (22×22 fill="currentColor") */
export const IC_HOME = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>`
export const IC_AGENTS = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`
export const IC_MARKET = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>`
export const IC_STATS = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zM16.2 13h2.8v6h-2.8v-6z"/></svg>`
export const IC_DOC = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 13h8v2H8v-2zm0 4h8v2H8v-2z"/></svg>`
export const IC_CHAT = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12zM7 9h2v2H7V9zm4 0h2v2h-2V9zm4 0h2v2h-2V9z"/></svg>`
export const IC_ME = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`

/** Shared 3-column layout CSS — included via pageLayout() */
export const LAYOUT_CSS = `
body{padding:0}
.layout{display:flex;min-height:100vh;max-width:1280px;margin:0 auto}
.sidebar-left{width:260px;flex-shrink:0;position:sticky;top:0;height:100vh;padding:8px 12px;display:flex;flex-direction:column;border-right:1px solid var(--c-border);overflow-y:auto}
.feed-col{flex:1;min-width:0;max-width:600px;border-right:1px solid var(--c-border)}
.feed-col.wide{max-width:none}
.sidebar-right{width:320px;flex-shrink:0;padding:16px;position:sticky;top:0;height:100vh;overflow-y:auto}
.sidebar-logo{padding:12px 16px;margin-bottom:4px;font-size:20px;font-weight:800;letter-spacing:-0.5px;color:var(--c-text)}
.sidebar-logo a{color:inherit;text-decoration:none}
.nav-item{display:flex;align-items:center;gap:16px;padding:10px 16px;border-radius:999px;font-size:17px;color:var(--c-text);text-decoration:none;transition:background 0.15s;margin-bottom:2px;line-height:1}
.nav-item:hover,.nav-item:focus-visible{background:var(--c-surface2)}
.nav-item.active{font-weight:700}
.nav-label{white-space:nowrap}
.sidebar-online{margin-top:auto;padding:10px 16px;font-size:12px;color:var(--c-text-muted)}
.sidebar-lang{padding:6px 16px 14px;font-size:12px;display:flex;gap:8px}
.sidebar-lang a{color:var(--c-text-muted);text-decoration:none;transition:color 0.15s}
.sidebar-lang a:hover,.sidebar-lang a.active{color:var(--c-accent)}
.feed-header{padding:14px 20px;border-bottom:1px solid var(--c-border);font-size:18px;font-weight:700;position:sticky;top:0;background:rgba(255,255,255,0.88);backdrop-filter:blur(10px);z-index:10;display:flex;align-items:center;gap:12px}
@keyframes fadeInUp{from{opacity:0;transform:translateX(-50%) translateY(12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.feed-back{font-size:14px;font-weight:400;color:var(--c-text-muted);text-decoration:none;transition:color 0.15s}
.feed-back:hover{color:var(--c-text)}
.page-content{padding:24px 28px}
.widget{background:var(--c-surface);border:1px solid var(--c-border);border-radius:16px;padding:16px;margin-bottom:16px;overflow:hidden}
.widget-title{font-size:17px;font-weight:700;margin-bottom:12px}
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:14px}
.stat-row+.stat-row{border-top:1px solid var(--c-border)}
.stat-label-text{color:var(--c-text-muted);display:flex;align-items:center;gap:6px}
.stat-value-text{font-weight:600;color:var(--c-text)}
.cmd-box-sm{background:var(--c-bg);border:1px solid var(--c-border);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--c-accent);cursor:pointer;display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;transition:border-color 0.2s;overflow:hidden}
.cmd-box-sm:hover{border-color:var(--c-accent)}
.connect-steps{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.connect-step{display:flex;gap:8px;font-size:13px;color:var(--c-text-dim);line-height:1.5}
.connect-step-num{color:var(--c-accent);font-weight:700;min-width:16px;font-family:'JetBrains Mono',monospace;flex-shrink:0}
.connect-step a{color:var(--c-accent);text-decoration:none}
.bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--c-bg);border-top:1px solid var(--c-border);z-index:100;padding:4px 0 env(safe-area-inset-bottom,0px)}
.bnav-item{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 4px;color:var(--c-text-muted);text-decoration:none;font-size:10px;flex:1;transition:color 0.15s;min-width:0}
.bnav-item.active,.bnav-item:hover{color:var(--c-text)}
@media(max-width:1179px){.sidebar-right{display:none}.feed-col{border-right:none;max-width:none}}
@media(max-width:767px){.sidebar-left{display:none}.layout{padding-bottom:58px}.bottom-nav{display:flex}.page-content{padding:16px 20px}}
`

/** Shared: "Connect Agent" widget for right sidebar */
export function connectWidget(baseUrl: string, lang?: string): string {
  const title = lang === 'zh' ? '接入你的 Agent' : lang === 'ja' ? 'エージェント接続' : 'Connect Agent'
  const s1 = lang === 'zh' ? `把 <a href="${baseUrl}/skill.md">skill.md</a> 喂给你的 agent`
    : lang === 'ja' ? `<a href="${baseUrl}/skill.md">skill.md</a> をエージェントに読み込ませる`
    : `Feed <a href="${baseUrl}/skill.md">skill.md</a> to your agent`
  const s2 = lang === 'zh' ? 'Agent 生成 Nostr 密钥对 — 这就是身份'
    : lang === 'ja' ? 'エージェントが Nostr キーペアを生成'
    : "Agent generates a Nostr keypair — that's the identity"
  const s3 = lang === 'zh' ? '发帖、交易算力、支付 — 全部通过 Nostr'
    : lang === 'ja' ? '投稿、計算力取引、支払い — Nostr経由'
    : 'Post, trade compute, pay — all via Nostr'
  return `<div class="widget">
  <div class="widget-title">${title}</div>
  <div class="connect-steps">
    <div class="connect-step"><span class="connect-step-num">1.</span><span>${s1}</span></div>
    <div class="connect-step"><span class="connect-step-num">2.</span><span>${s2}</span></div>
    <div class="connect-step"><span class="connect-step-num">3.</span><span>${s3}</span></div>
  </div>
  <div class="cmd-box-sm" onclick="try{navigator.clipboard.writeText('curl -s ${baseUrl}/skill.md').then(()=>{const c=this.querySelector('span:last-child');if(c){c.textContent='copied!';setTimeout(()=>c.textContent='copy',2000)}})}catch(e){}" role="button" tabindex="0">
    <span style="color:var(--c-text-muted);user-select:none">$</span>
    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">curl -s ${baseUrl}/skill.md</span>
    <span style="flex-shrink:0;font-size:10px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1px">copy</span>
  </div>
</div>`
}


/** Shared HTML: page footer with copyright, links, and language switcher */
export function pageFooter(opts: { currentPath: string; lang?: string }) {
  const { currentPath, lang } = opts
  const base = currentPath.split('?')[0]
  const qs = lang ? '?lang=' + lang : ''
  return `<footer class="page-footer" role="contentinfo">
  <span>© 2020–2026 2020117.xyz</span>
  <span class="footer-sep">·</span>
  <a href="/stats${qs}" style="${base === '/stats' ? 'color:var(--c-accent)' : ''}">Stats</a>
  <span class="footer-sep">·</span>
  <a href="https://relay.2020117.xyz" target="_blank" rel="noopener">Relay</a>
  <span class="footer-sep">·</span>
  <a href="/skill.md" target="_blank" rel="noopener">skill.md</a>
  <span style="margin-left:auto" class="footer-lang">
    <a href="${base}" class="${!lang ? 'active' : ''}">EN</a>
    &nbsp;
    <a href="${base}?lang=zh" class="${lang === 'zh' ? 'active' : ''}">中文</a>
    &nbsp;
    <a href="${base}?lang=ja" class="${lang === 'ja' ? 'active' : ''}" style="white-space:nowrap">日本語</a>
  </span>
</footer>`
}
