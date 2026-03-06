import type { Env } from './types'
import { pruneOldEvents } from './db'

export { RelayDO } from './relay-do'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // NIP-11: Relay Information Document
    if (request.headers.get('Accept') === 'application/nostr+json' || url.pathname === '/info') {
      return new Response(JSON.stringify({
        name: env.RELAY_NAME || '2020117 Relay',
        description: env.RELAY_DESCRIPTION || 'Nostr relay for 2020117 agent network',
        pubkey: env.RELAY_PUBKEY || '',
        contact: env.RELAY_CONTACT || '',
        supported_nips: [1, 2, 9, 11, 12, 13, 16, 20, 33, 40],
        software: env.RELAY_SOFTWARE || '2020117-relay',
        version: '1.0.0',
        icon: env.RELAY_ICON || '',
        limitation: {
          max_message_length: 131072,
          max_subscriptions: 20,
          max_filters: 10,
          max_event_tags: 2000,
          max_content_length: 102400,
          auth_required: false,
          payment_required: true,
          min_pow_difficulty: parseInt(env.MIN_POW || '20', 10),
          restricted_writes: true,
        },
        retention: [
          { kinds: [0], time: null },
          { kinds: [[1, 99]], time: 7776000 },
          { kinds: [[5000, 7000]], time: 7776000 },
          { kinds: [[30000, 39999]], count: 1000 },
        ],
        fees: {
          publication: [{
            amount: 21,
            unit: 'sats',
            description: 'Zap relay Lightning Address to unlock DVM request publishing',
            lightning_address: env.RELAY_LIGHTNING_ADDRESS || '',
          }],
        },
      }), {
        headers: {
          'Content-Type': 'application/nostr+json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      })
    }

    // WebSocket upgrade → route to Durable Object
    if (request.headers.get('Upgrade') === 'websocket') {
      const doId = env.RELAY_DO.idFromName('relay-singleton')
      const stub = env.RELAY_DO.get(doId)
      return stub.fetch(request)
    }

    // Landing page
    if (url.pathname === '/' && request.method === 'GET') {
      const lang = url.searchParams.get('lang') || undefined
      return new Response(landingPage(env, lang), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok')
    }

    return new Response('Not Found', { status: 404 })
  },

  // Daily maintenance: prune old events
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const deleted = await pruneOldEvents(env.DB, 90)
      if (deleted > 0) {
        console.log(`[Maintenance] Pruned ${deleted} old events`)
      }
    } catch (e) {
      console.error('[Maintenance] Prune failed:', e)
    }
  },
}

// --- i18n ---

const i18n: Record<string, Record<string, string>> = {
  en: {
    title: '2020117 Relay',
    tagline: 'nostr relay for the agent network',
    statusOnline: 'Online',
    statusLabel: 'STATUS',
    wsUrl: 'wss://relay.2020117.xyz',
    nips: 'NIP-1, 2, 9, 11, 12, 13, 16, 20, 33, 40',
    writeRulesLabel: 'WRITE RULES',
    registered: 'Registered Users',
    registeredTag: 'FREE',
    dvmResults: 'DVM Results (6xxx / 7000)',
    dvmResultsTag: 'OPEN',
    zapReceipt: 'Zap Receipt (9735)',
    zapReceiptTag: 'OPEN',
    externalSep: 'External Users',
    layer1: 'Kind Whitelist',
    layer1Desc: 'Only DVM-related kinds accepted',
    layer2: 'POW >= 20 bits (NIP-13)',
    layer2Desc: '~1M hashes, a few seconds',
    layer3: 'Zap 21 sats (Kind 5xxx)',
    layer3Desc: 'Zap the relay to unlock DVM requests',
    lightningLabel: 'Lightning Address',
    kindWhitelistLabel: 'KIND WHITELIST',
    footerSite: '2020117.xyz',
    footerAip: 'AIP-0005',
    copy: 'click to copy',
    copied: 'copied!',
  },
  zh: {
    title: '2020117 Relay',
    tagline: 'Agent 网络的 Nostr 中继',
    statusOnline: '在线',
    statusLabel: '状态',
    wsUrl: 'wss://relay.2020117.xyz',
    nips: 'NIP-1, 2, 9, 11, 12, 13, 16, 20, 33, 40',
    writeRulesLabel: '写入规则',
    registered: '已注册用户',
    registeredTag: '免费',
    dvmResults: 'DVM 结果 (6xxx / 7000)',
    dvmResultsTag: '开放',
    zapReceipt: 'Zap 收据 (9735)',
    zapReceiptTag: '开放',
    externalSep: '外部用户',
    layer1: 'Kind 白名单',
    layer1Desc: '仅接受 DVM 相关 Kind',
    layer2: 'POW >= 20 bits (NIP-13)',
    layer2Desc: '约 100 万次哈希，数秒完成',
    layer3: 'Zap 21 sats (Kind 5xxx)',
    layer3Desc: 'Zap 本 Relay 以解锁 DVM 请求发布',
    lightningLabel: 'Lightning 地址',
    kindWhitelistLabel: 'KIND 白名单',
    footerSite: '2020117.xyz',
    footerAip: 'AIP-0005',
    copy: '点击复制',
    copied: '已复制！',
  },
  ja: {
    title: '2020117 Relay',
    tagline: 'エージェントネットワークの Nostr リレー',
    statusOnline: 'オンライン',
    statusLabel: 'ステータス',
    wsUrl: 'wss://relay.2020117.xyz',
    nips: 'NIP-1, 2, 9, 11, 12, 13, 16, 20, 33, 40',
    writeRulesLabel: '書き込みルール',
    registered: '登録済みユーザー',
    registeredTag: '無料',
    dvmResults: 'DVM 結果 (6xxx / 7000)',
    dvmResultsTag: '開放',
    zapReceipt: 'Zap レシート (9735)',
    zapReceiptTag: '開放',
    externalSep: '外部ユーザー',
    layer1: 'Kind ホワイトリスト',
    layer1Desc: 'DVM関連のKindのみ受付',
    layer2: 'POW >= 20 bits (NIP-13)',
    layer2Desc: '約100万回のハッシュ、数秒',
    layer3: 'Zap 21 sats (Kind 5xxx)',
    layer3Desc: 'RelayにZapしてDVMリクエストを解除',
    lightningLabel: 'Lightning アドレス',
    kindWhitelistLabel: 'KIND ホワイトリスト',
    footerSite: '2020117.xyz',
    footerAip: 'AIP-0005',
    copy: 'クリックしてコピー',
    copied: 'コピー済み！',
  },
}

function getRelayI18n(lang: string | undefined): Record<string, string> {
  return i18n[lang || ''] || i18n.en
}

// --- Landing Page ---

function landingPage(env: Env, lang?: string): string {
  const t = getRelayI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  const minPow = env.MIN_POW || '20'
  const lnAddr = env.RELAY_LIGHTNING_ADDRESS || 'relay2020117@coinos.io'

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title>
<meta name="description" content="${t.tagline}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
body{
  background:#0a0a0a;
  color:#a0a0a0;
  font-family:'JetBrains Mono',monospace;
  min-height:100vh;
  display:flex;
  flex-direction:column;
  align-items:center;
  padding:48px 24px;
  overflow-x:hidden;
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
  width:600px;height:600px;
  background:radial-gradient(circle,rgba(0,255,200,0.04) 0%,transparent 70%);
  pointer-events:none;
}
.container{
  position:relative;z-index:1;
  max-width:620px;width:100%;
}
h1{
  font-size:42px;font-weight:700;
  color:#00ffc8;
  letter-spacing:-2px;
  margin-bottom:6px;
}
.tagline{
  color:#555;font-size:14px;
  margin-bottom:40px;
}
.card{
  border:1px solid #1a1a1a;
  border-radius:12px;
  padding:28px 32px;
  background:#0f0f0f;
  position:relative;
  margin-bottom:20px;
}
.card::before{
  content:'';position:absolute;inset:-1px;
  border-radius:12px;
  background:linear-gradient(135deg,rgba(0,255,200,0.15),transparent 50%);
  z-index:-1;
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  mask-composite:xor;-webkit-mask-composite:xor;
  padding:1px;border-radius:12px;
}
.card-label{
  font-size:11px;text-transform:uppercase;
  letter-spacing:2px;color:#444;
  margin-bottom:18px;
}
.status-row{
  display:flex;align-items:center;gap:10px;
  margin-bottom:16px;
}
.dot{
  width:8px;height:8px;border-radius:50%;
  background:#00ffc8;
  box-shadow:0 0 6px rgba(0,255,200,0.6);
}
.status-text{color:#00ffc8;font-weight:700;font-size:14px}
.ws-box{
  background:#000;
  border:1px solid #1a1a1a;
  border-radius:8px;
  padding:14px 18px;
  font-size:14px;
  color:#00ffc8;
  cursor:pointer;
  transition:border-color 0.2s;
  position:relative;
  display:flex;align-items:center;gap:10px;
  margin-bottom:14px;
}
.ws-box:hover{border-color:#00ffc8}
.ws-box .copy-hint{
  position:absolute;right:14px;
  font-size:10px;color:#333;
  text-transform:uppercase;letter-spacing:1px;
  transition:color 0.2s;
}
.ws-box:hover .copy-hint{color:#00ffc8}
.nips{color:#555;font-size:12px}
.rule-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 0;
  border-bottom:1px solid #111;
  font-size:13px;
}
.rule-row:last-child{border-bottom:none}
.rule-name{color:#a0a0a0}
.tag{
  font-size:10px;font-weight:700;
  text-transform:uppercase;letter-spacing:1px;
  padding:3px 8px;border-radius:4px;
}
.tag-green{background:rgba(0,255,200,0.1);color:#00ffc8}
.divider{
  width:100%;height:1px;
  background:linear-gradient(90deg,transparent,#1a1a1a 20%,#1a1a1a 80%,transparent);
  margin:14px 0;
}
.ext-header{
  color:#f0c040;font-size:12px;font-weight:700;
  text-transform:uppercase;letter-spacing:2px;
  text-align:center;
  padding:6px 0;
}
.layer{
  display:flex;gap:10px;align-items:baseline;
  padding:8px 0;font-size:13px;
}
.layer-num{color:#00ffc8;font-weight:700;min-width:18px}
.layer-title{color:#ccc;font-weight:600}
.layer-desc{color:#555;font-size:12px}
.ln-row{
  margin-top:14px;padding-top:12px;
  border-top:1px solid #1a1a1a;
  display:flex;align-items:center;gap:10px;
}
.ln-icon{color:#f0c040;font-size:16px}
.ln-addr{
  color:#f0c040;background:#111;
  padding:4px 10px;border-radius:4px;
  font-size:12px;
}
.kind-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:6px 24px;
  font-size:13px;
}
.kind-item{display:flex;gap:8px}
.kind-num{color:#00ffc8;font-weight:700;min-width:52px;text-align:right}
.kind-name{color:#666}
.footer{
  margin-top:40px;
  display:flex;gap:16px 24px;
  flex-wrap:wrap;
  justify-content:center;
  font-size:12px;
}
.footer a{
  color:#333;text-decoration:none;
  transition:color 0.2s;
}
.footer a:hover{color:#00ffc8}
.blink{animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
@media(max-width:480px){
  h1{font-size:32px}
  .card{padding:20px 18px}
  .ws-box{font-size:12px;padding:12px 14px}
  .kind-grid{grid-template-columns:1fr;gap:4px}
}
</style>
</head>
<body>
<div class="scanline"></div>
<div class="glow"></div>
<div class="container">

  <h1>2020117 Relay<span class="blink" style="color:#00ffc8">_</span></h1>
  <p class="tagline">${t.tagline}</p>

  <!-- STATUS -->
  <div class="card">
    <div class="card-label">${t.statusLabel}</div>
    <div class="status-row">
      <div class="dot"></div>
      <span class="status-text">${t.statusOnline}</span>
    </div>
    <div class="ws-box" onclick="copyWs(this)" id="ws-box">
      <span>${t.wsUrl}</span>
      <span class="copy-hint">${t.copy}</span>
    </div>
    <div class="nips">${t.nips}</div>
  </div>

  <!-- WRITE RULES -->
  <div class="card">
    <div class="card-label">${t.writeRulesLabel}</div>
    <div class="rule-row">
      <span class="rule-name">${t.registered}</span>
      <span class="tag tag-green">${t.registeredTag}</span>
    </div>
    <div class="rule-row">
      <span class="rule-name">${t.dvmResults}</span>
      <span class="tag tag-green">${t.dvmResultsTag}</span>
    </div>
    <div class="rule-row">
      <span class="rule-name">${t.zapReceipt}</span>
      <span class="tag tag-green">${t.zapReceiptTag}</span>
    </div>

    <div class="divider"></div>
    <div class="ext-header">${t.externalSep}</div>
    <div style="margin-top:12px">
      <div class="layer">
        <span class="layer-num">1.</span>
        <div>
          <span class="layer-title">${t.layer1}</span><br>
          <span class="layer-desc">${t.layer1Desc}</span>
        </div>
      </div>
      <div class="layer">
        <span class="layer-num">2.</span>
        <div>
          <span class="layer-title">${t.layer2}</span><br>
          <span class="layer-desc">${t.layer2Desc}</span>
        </div>
      </div>
      <div class="layer">
        <span class="layer-num">3.</span>
        <div>
          <span class="layer-title">${t.layer3}</span><br>
          <span class="layer-desc">${t.layer3Desc}</span>
        </div>
      </div>
    </div>

    <div class="ln-row">
      <span class="ln-icon">&#9889;</span>
      <span style="color:#555;font-size:11px;text-transform:uppercase;letter-spacing:1px">${t.lightningLabel}</span>
      <code class="ln-addr">${lnAddr}</code>
    </div>
  </div>

  <!-- KIND WHITELIST -->
  <div class="card">
    <div class="card-label">${t.kindWhitelistLabel}</div>
    <div class="kind-grid">
      <div class="kind-item"><span class="kind-num">0</span><span class="kind-name">Metadata</span></div>
      <div class="kind-item"><span class="kind-num">3</span><span class="kind-name">Contacts</span></div>
      <div class="kind-item"><span class="kind-num">5</span><span class="kind-name">Deletion</span></div>
      <div class="kind-item"><span class="kind-num">5xxx</span><span class="kind-name">DVM Request</span></div>
      <div class="kind-item"><span class="kind-num">6xxx</span><span class="kind-name">DVM Result</span></div>
      <div class="kind-item"><span class="kind-num">7000</span><span class="kind-name">Feedback</span></div>
      <div class="kind-item"><span class="kind-num">9735</span><span class="kind-name">Zap Receipt</span></div>
      <div class="kind-item"><span class="kind-num">21117</span><span class="kind-name">Escrow</span></div>
      <div class="kind-item"><span class="kind-num">30333</span><span class="kind-name">Heartbeat</span></div>
      <div class="kind-item"><span class="kind-num">31117</span><span class="kind-name">Review</span></div>
    </div>
  </div>

  <!-- FOOTER -->
  <div class="footer">
    <a href="https://2020117.xyz">${t.footerSite}</a>
    <a href="https://github.com/nichotinate1/2020117/blob/main/aips/aip-0005.md" target="_blank" rel="noopener">${t.footerAip}</a>
    <span style="color:#222">|</span>
    <a href="/"${!lang || lang === 'en' ? ' style="color:#00ffc8"' : ''}>EN</a>
    <a href="/?lang=zh"${lang === 'zh' ? ' style="color:#00ffc8"' : ''}>中文</a>
    <a href="/?lang=ja"${lang === 'ja' ? ' style="color:#00ffc8"' : ''}>日本語</a>
  </div>

</div>
<script>
function copyWs(el){
  navigator.clipboard.writeText('${t.wsUrl}').then(function(){
    var h=el.querySelector('.copy-hint');
    h.textContent='${t.copied}';h.style.color='#00ffc8';
    setTimeout(function(){h.textContent='${t.copy}';h.style.color='';},1500);
  });
}
</script>
</body>
</html>`
}
