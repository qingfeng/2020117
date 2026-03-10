/**
 * Shared CSS and HTML fragments for all pages.
 * Polish pass: accessibility, contrast, focus states, reduced motion, semantic HTML.
 */

/** Font preconnect + link tags (replaces render-blocking @import) */
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap">`

/** CSS custom properties + base reset + shared components */
export const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --c-bg:#0a0a0a;
  --c-surface:#0f0f0f;
  --c-border:#1a1a1a;
  --c-text:#a0a0a0;
  --c-text-dim:#586e75;
  --c-text-muted:#666;
  --c-accent:#00ffc8;
  --c-accent-dim:#1a3a30;
  --c-accent-bg:#0a1a15;
  --c-nav:#707070;
  --c-nav-active:var(--c-accent);
  --c-gold:#ffb000;
  --c-teal:#2aa198;
  --c-blue:#268bd2;
  --c-red:#dc322f;
  --c-magenta:#d33682;
  --c-purple:#6c71c4;
  --c-olive:#859900;
  --c-profile:#b58900;
}
body{
  background:var(--c-bg);
  color:var(--c-text);
  font-family:'JetBrains Mono',monospace;
  min-height:100vh;
  padding:24px;
  overflow-x:hidden;
}
/* Accessibility: focus indicators */
a:focus-visible,button:focus-visible,[tabindex]:focus-visible{
  outline:2px solid var(--c-accent);
  outline-offset:2px;
  border-radius:2px;
}
/* Accessibility: reduced motion */
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{
    animation-duration:0.01ms !important;
    animation-iteration-count:1 !important;
    transition-duration:0.01ms !important;
  }
}
.scanline{
  position:fixed;top:0;left:0;width:100%;height:100%;
  pointer-events:none;z-index:10;
  background:repeating-linear-gradient(
    0deg,transparent,transparent 2px,
    rgba(0,255,200,0.015) 2px,rgba(0,255,200,0.015) 4px
  );
}
.glow{
  position:fixed;top:50%;left:50%;
  transform:translate(-50%,-50%);
  width:min(600px,100vw);height:min(600px,100vh);
  background:radial-gradient(circle,rgba(0,255,200,0.04) 0%,transparent 70%);
  pointer-events:none;
}
.container{
  position:relative;z-index:1;
  max-width:720px;width:100%;
  margin:0 auto;
}
/* Header navigation */
header{
  display:flex;align-items:baseline;gap:16px;
  margin-bottom:32px;
}
header h1{
  font-size:26px;font-weight:700;
  color:var(--c-accent);letter-spacing:-1px;
}
header a{
  color:var(--c-nav);text-decoration:none;font-size:14px;
  transition:color 0.2s;
}
header a:hover{color:var(--c-accent)}
/* Card with gradient border */
.card-base{
  border:1px solid var(--c-border);
  border-radius:12px;
  padding:24px 28px;
  background:var(--c-surface);
  position:relative;
}
.card-base::before{
  content:'';position:absolute;inset:-1px;
  border-radius:12px;
  background:linear-gradient(135deg,rgba(0,255,200,0.15),transparent 50%);
  z-index:-1;
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  mask-composite:xor;-webkit-mask-composite:xor;
  padding:1px;border-radius:12px;
}
/* Kind tag */
.kind-tag{
  display:inline-block;
  background:var(--c-accent-bg);
  border:1px solid var(--c-accent-dim);
  border-radius:4px;
  padding:3px 10px;
  font-size:12px;
  color:var(--c-accent);
}
/* Status indicator */
.status{
  font-size:12px;color:var(--c-nav);
  text-transform:uppercase;letter-spacing:2px;
  margin-bottom:16px;
}
.dot{
  display:inline-block;width:6px;height:6px;
  background:var(--c-accent);border-radius:50%;
  margin-right:8px;
}
/* Labels */
.section-label{
  font-size:11px;color:var(--c-text-muted);
  text-transform:uppercase;letter-spacing:1.5px;
  margin-bottom:8px;
}
/* Empty state */
.empty{color:var(--c-text-muted);font-size:14px;font-style:italic}
/* Error state */
.error-msg{
  color:var(--c-red);font-size:14px;
  padding:16px;
  border:1px solid rgba(220,50,47,0.2);
  border-radius:8px;
  background:rgba(220,50,47,0.05);
  display:flex;align-items:center;gap:10px;
}
.error-msg button{
  background:none;border:1px solid var(--c-red);
  color:var(--c-red);padding:4px 12px;border-radius:4px;
  font-family:inherit;font-size:13px;cursor:pointer;
  transition:background 0.2s;
}
.error-msg button:hover{background:rgba(220,50,47,0.1)}
/* Loading skeleton */
.skeleton{
  background:linear-gradient(90deg,var(--c-border) 25%,var(--c-surface) 50%,var(--c-border) 75%);
  background-size:200% 100%;
  animation:shimmer 1.5s infinite;
  border-radius:4px;
}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* Text overflow utilities */
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.line-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.line-clamp-3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.break-word{word-break:break-word;overflow-wrap:break-word}
/* Flex overflow prevention */
.flex-min-0{min-width:0}
/* Blink animation */
.blink{animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
/* Touch targets */
@media(max-width:480px){
  body{padding:16px}
  .card-base{padding:16px 18px}
}
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

/** Shared HTML: decorative overlays */
export function overlays() {
  return `<div class="scanline" aria-hidden="true"></div>
<div class="glow" aria-hidden="true"></div>`
}

/** Shared HTML: header with nav */
export function headerNav(opts: { currentPath: string; lang?: string; extra?: string }) {
  const { currentPath, lang, extra } = opts
  const qs = lang ? '?lang=' + lang : ''
  const active = (p: string) => currentPath === p ? ` style="color:var(--c-accent)"` : ''
  return `<header role="banner">
  <h1><a href="/${qs}" style="color:inherit;text-decoration:none">2020117<span class="blink" style="color:var(--c-accent)">_</span></a></h1>
  <nav role="navigation" aria-label="main" style="display:contents">
  <a href="/${qs}"${active('/')}>back</a>
  <a href="/relay${qs}"${active('/relay')}>relay</a>
  <a href="/agents${qs}"${active('/agents')}>agents</a>
  ${extra || ''}
  <span style="flex:1"></span>
  <a href="${currentPath}"${!lang ? ' style="color:var(--c-accent)"' : ''}>EN</a>
  <a href="${currentPath}?lang=zh"${lang === 'zh' ? ' style="color:var(--c-accent)"' : ''}>中文</a>
  <a href="${currentPath}?lang=ja"${lang === 'ja' ? ' style="color:var(--c-accent)"' : ''}>日本語</a>
  </nav>
</header>`
}
