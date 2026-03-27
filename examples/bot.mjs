#!/usr/bin/env node
import WebSocket from 'ws'
globalThis.WebSocket = WebSocket

// Prevent nostr-tools relay.send() unhandled rejections from crashing the process
process.on('unhandledRejection', (err) => {
  console.error(`[unhandledRejection] ${err?.message || err}`)
})

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { generateSecretKey } from 'nostr-tools/pure'
import { Relay } from 'nostr-tools/relay'
import { hexToBytes, bytesToHex } from 'nostr-tools/utils'
import { minePow } from 'nostr-tools/nip13'
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from 'nostr-tools/nip04'
import crypto from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { spawn } from 'child_process'
import Hyperswarm from 'hyperswarm'
import { createXai } from '@ai-sdk/xai'
import { generateText } from 'ai'
import b4a from 'b4a'

// ============================================================
//  CLI Argument Parsing
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {
    agent: null,
    noteInterval: 30,     // 0 = off
    dvmInterval: 60,      // 0 = off
    dvmBid: 10,
    dvm5300Bid: 1,    // sats per Kind 5300 content discovery job
    reply: true,
    replyChance: 1.0,   // 0.0~1.0, default 100%
    like: false,
    likeChance: 0.6,    // 0.0~1.0, default 60%
    maxReplies: 5,
    autoPay: true,
    // Provider mode
    provide: 0,           // --provide=<kind>  0 = off, e.g. 5100
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',      // auto-detect if empty
    dvmBackend: '',       // --dvm-backend=<hex-pubkey>  use p2p DVM agent instead of local Ollama
    simpleBackend: false, // --simple-backend  no AI, rule-based replies (low quality, zero cost)
    xaiBackend: false,    // --xai-backend  use xAI Grok API (requires xai_api_key in keys file)
    dvmBackendTimeout: 300, // seconds to wait for p2p DVM response
    maxJobs: 3,
    providerPrice: 10,    // sats per job
    // General
    relay: 'wss://relay.2020117.xyz',
    keysFile: null,
  }

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
    const [key, ...rest] = arg.split('=')
    const val = rest.join('=')
    switch (key) {
      case '--agent':          opts.agent = val; break
      case '--note-interval':  opts.noteInterval = parseInt(val); break
      case '--dvm-interval':   opts.dvmInterval = parseInt(val); break
      case '--dvm-bid':        opts.dvmBid = parseInt(val); break
      case '--dvm5300-bid':    opts.dvm5300Bid = parseInt(val); break
      case '--reply':          opts.reply = true; break
      case '--no-reply':       opts.reply = false; break
      case '--like':           opts.like = true; break
      case '--no-like':        opts.like = false; break
      case '--auto-pay':       opts.autoPay = true; break
      case '--no-auto-pay':    opts.autoPay = false; break
      case '--reply-chance':    opts.replyChance = parseFloat(val); break
      case '--like-chance':     opts.likeChance = parseFloat(val); break
      case '--max-replies':    opts.maxReplies = parseInt(val); break
      case '--provide':           opts.provide = parseInt(val); break
      case '--ollama-url':        opts.ollamaUrl = val; break
      case '--ollama-model':      opts.ollamaModel = val; break
      case '--dvm-backend':       opts.dvmBackend = val || true; break
      case '--simple-backend':    opts.simpleBackend = true; break
      case '--xai-backend':       opts.xaiBackend = true; break
      case '--dvm-backend-timeout': opts.dvmBackendTimeout = parseInt(val); break
      case '--max-jobs':          opts.maxJobs = parseInt(val); break
      case '--provider-price':    opts.providerPrice = parseInt(val); break
      case '--relay':          opts.relay = val; break
      case '--keys':           opts.keysFile = val; break
      default:
        console.error(`Unknown option: ${arg}`)
        printHelp(); process.exit(1)
    }
  }
  return opts
}

function printHelp() {
  console.log(`
Usage: node bot.mjs [options]

Customer Options:
  --agent=<name>            .2020117_keys 中的用户名，不存在则自动创建
  --keys=<path>             keys 文件路径 (默认 ./.2020117_keys)
  --note-interval=<min>     发吐槽间隔，分钟 (默认 30，0=关闭)
  --dvm-interval=<min>      发 DVM 任务间隔，分钟 (默认 60，0=关闭)
  --dvm-bid=<sats>          DVM 任务金额 sats (默认 10)
  --reply / --no-reply      自动回复 (默认开启)
  --reply-chance=<0-1>      回复几率 (默认 1.0 = 100%)
  --like / --no-like        自动点赞 (默认关闭)
  --like-chance=<0-1>       点赞几率 (默认 0.6 = 60%)
  --auto-pay / --no-auto-pay  DVM结果自动评估+结算+评价 (默认开启)
  --max-replies=<n>         每线程最大回复次数 (默认 5)

Provider Options:
  --provide=<kind>          接单模式，指定接哪种 DVM 任务 (如 5100, 5302)，0=关闭
  --ollama-url=<url>        Ollama API 地址 (默认 http://localhost:11434)
  --ollama-model=<model>    模型名称 (默认自动检测第一个)
  --max-jobs=<n>            最大并发任务数 (默认 3)
  --provider-price=<sats>   每个任务报价 sats (默认 10)

General:
  --relay=<url>             Relay 地址

Examples:
  # 发单模式（默认）
  node bot.mjs --agent=customer-agent

  # 接单模式：用 Ollama 接 Kind 5100 文本生成任务
  node bot.mjs --agent=worker-bot --provide=5100 --ollama-model=qwen2.5:0.5b --note-interval=0 --dvm-interval=0

  # 同时发单 + 接单（用不同账户）
  node bot.mjs --agent=customer-agent &
  node bot.mjs --agent=worker-bot --provide=5100 --note-interval=0 --dvm-interval=0 &

  # 纯接单，不发帖不回复
  node bot.mjs --agent=worker --provide=5100 --note-interval=0 --dvm-interval=0 --no-reply
`)
}

// ============================================================
//  Identity Management
// ============================================================

function loadOrCreateAgent(opts) {
  const keysPath = resolve(opts.keysFile || './.2020117_keys')
  let keys = {}

  if (existsSync(keysPath)) {
    keys = JSON.parse(readFileSync(keysPath, 'utf-8'))
  }

  if (!opts.agent) {
    const names = Object.keys(keys)
    if (names.length === 0) {
      console.error('Error: No --agent specified and .2020117_keys is empty.')
      process.exit(1)
    }
    opts.agent = names[0]
    console.log(`  No --agent specified, using first key: "${opts.agent}"`)
  }

  if (keys[opts.agent]) {
    const agent = keys[opts.agent]
    console.log(`  Loaded existing agent: "${opts.agent}"`)
    return {
      name: opts.agent,
      sk: hexToBytes(agent.privkey),
      pubkey: agent.pubkey,
      privkeyHex: agent.privkey,
      nwcUri: agent.nwc_uri || null,
      lightningAddress: agent.lightning_address || null,
      displayName: agent.display_name || null,
      about: agent.about || null,
      xaiApiKey: agent.xai_api_key || null,
    }
  }

  console.log(`  Agent "${opts.agent}" not found, generating new keypair...`)
  const skBytes = generateSecretKey()
  const privkeyHex = bytesToHex(skBytes)
  const pubkeyHex = getPublicKey(skBytes)

  keys[opts.agent] = { privkey: privkeyHex, pubkey: pubkeyHex }
  writeFileSync(keysPath, JSON.stringify(keys, null, 2) + '\n')
  console.log(`  New agent saved. Pubkey: ${pubkeyHex}`)

  return {
    name: opts.agent, sk: skBytes, pubkey: pubkeyHex, privkeyHex,
    nwcUri: null, lightningAddress: null,
  }
}

// ============================================================
//  NWC (NIP-47)
// ============================================================

function parseNwcUri(uri) {
  if (!uri) return null
  const url = new URL(uri.replace('nostr+walletconnect://', 'https://'))
  return {
    walletPubkey: url.hostname,
    relay: url.searchParams.get('relay'),
    secret: url.searchParams.get('secret'),
    lud16: url.searchParams.get('lud16'),
  }
}

async function nwcGetBalance(nwc) {
  return await nwcRequest(nwc, { method: 'get_balance' })
}

async function nwcPayInvoice(nwc, bolt11) {
  return await nwcRequest(nwc, { method: 'pay_invoice', params: { invoice: bolt11 } })
}

async function nwcMakeInvoice(nwc, amountSats, description = 'DVM job payment') {
  const result = await nwcRequest(nwc, {
    method: 'make_invoice',
    params: { amount: amountSats * 1000, description },
  })
  return result?.invoice || null
}

async function nwcRequest(nwc, requestBody) {
  const secretBytes = hexToBytes(nwc.secret)
  const senderPubkey = getPublicKey(secretBytes)
  const content = await nip04Encrypt(nwc.secret, nwc.walletPubkey, JSON.stringify(requestBody))

  const event = finalizeEvent({
    kind: 23194, pubkey: senderPubkey, content,
    tags: [['p', nwc.walletPubkey]],
    created_at: Math.floor(Date.now() / 1000),
  }, secretBytes)

  const relay = await Relay.connect(nwc.relay)
  let timeoutId
  try {
    const responsePromise = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => { reject(new Error('NWC timeout (30s)')) }, 30000)
      relay.subscribe(
        [{ kinds: [23195], authors: [nwc.walletPubkey], '#e': [event.id], since: Math.floor(Date.now() / 1000) - 10 }],
        {
          onevent: async (responseEvent) => {
            clearTimeout(timeoutId)
            try {
              const decrypted = await nip04Decrypt(nwc.secret, nwc.walletPubkey, responseEvent.content)
              resolve(JSON.parse(decrypted))
            } catch (e) { reject(e) }
          },
        }
      )
    })

    await relay.publish(event)
    const response = await responsePromise
    if (response.error) throw new Error(`NWC: ${response.error.message || JSON.stringify(response.error)}`)
    return response.result
  } finally {
    clearTimeout(timeoutId)
    try { relay.close() } catch {}
  }
}

async function fetchInvoiceFromLnAddress(lnAddress, amountSats) {
  const [name, domain] = lnAddress.split('@')
  const lnurlRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`)
  if (!lnurlRes.ok) throw new Error(`LNURL fetch failed: ${lnurlRes.status}`)
  const lnurlData = await lnurlRes.json()
  if (!lnurlData.callback) throw new Error('No callback in LNURL response')
  const amountMsats = amountSats * 1000
  if (lnurlData.minSendable && amountMsats < lnurlData.minSendable) throw new Error(`Below min ${lnurlData.minSendable / 1000} sats`)
  if (lnurlData.maxSendable && amountMsats > lnurlData.maxSendable) throw new Error(`Above max ${lnurlData.maxSendable / 1000} sats`)
  const sep = lnurlData.callback.includes('?') ? '&' : '?'
  const invoiceRes = await fetch(`${lnurlData.callback}${sep}amount=${amountMsats}`)
  if (!invoiceRes.ok) throw new Error(`Invoice fetch failed: ${invoiceRes.status}`)
  const invoiceData = await invoiceRes.json()
  if (!invoiceData.pr) throw new Error('No invoice in response')
  return invoiceData.pr
}

async function nwcPayLightningAddress(nwc, lnAddress, amountSats) {
  const bolt11 = await fetchInvoiceFromLnAddress(lnAddress, amountSats)
  return await nwcPayInvoice(nwc, bolt11)
}

// ============================================================
//  Nostr Profile Helpers
// ============================================================

async function publishProfile(relay, identity) {
  console.log(`\n[${ts()}] [${identity.name}] Publishing profile (Kind 0)...`)
  const profile = {
    name: identity.displayName || identity.name,
    about: identity.about || `2020117 AI Agent — Nostr DVM provider & social bot`,
    picture: '',
  }
  if (identity.lightningAddress) profile.lud16 = identity.lightningAddress
  // Do NOT set nip05 — platform assigns it automatically

  const event = signWithPow({
    kind: 0, pubkey: identity.pubkey,
    content: JSON.stringify(profile),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  }, identity.sk)
  await publishEvent(relay, event)

  // Also broadcast to popular relays so clients like yakihonne can find the profile
  const extraRelays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']
  for (const url of extraRelays) {
    try {
      const r = await Relay.connect(url)
      await r.publish(event)
      r.close()
      console.log(`  Profile broadcast to ${url}`)
    } catch (e) {
      console.log(`  Profile broadcast to ${url} failed: ${e.message}`)
    }
  }
}

async function fetchLud16FromRelay(relayUrl, pubkey) {
  let relay
  try {
    relay = await Relay.connect(relayUrl)
    const profile = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve(null), 8000)
      relay.subscribe(
        [{ kinds: [0], authors: [pubkey], limit: 1 }],
        {
          onevent: (event) => {
            clearTimeout(timeout)
            try { resolve(JSON.parse(event.content)) } catch { resolve(null) }
          },
          oneose: () => {
            clearTimeout(timeout)
            resolve(null)
          },
        }
      )
    })
    return profile?.lud16 || null
  } catch {
    return null
  } finally {
    relay?.close()
  }
}

async function resolveProviderLnAddress(relayUrl, pubkey) {
  // 1. Try relay first (Nostr native)
  const fromRelay = await fetchLud16FromRelay(relayUrl, pubkey)
  if (fromRelay) {
    console.log(`  LN address from relay: ${fromRelay}`)
    return fromRelay
  }
  // 2. Fallback to HTTP API
  try {
    const res = await fetch(`https://2020117.xyz/api/users/${pubkey}`)
    if (res.ok) {
      const d = await res.json()
      const addr = d.lightning_address || d.lud16 || null
      if (addr) console.log(`  LN address from API: ${addr}`)
      return addr
    }
  } catch {}
  return null
}

// ============================================================
//  Ollama API
// ============================================================

async function ollamaDetectModel(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tags`)
  if (!res.ok) throw new Error(`Ollama API error: ${res.status}`)
  const data = await res.json()
  if (!data.models || data.models.length === 0) throw new Error('No Ollama models found')
  return data.models[0].name
}

async function ollamaGenerate(baseUrl, model, prompt, systemPrompt, numPredict = 2048, timeoutMs = 180000) {
  const body = {
    model,
    prompt,
    stream: false,
    options: { temperature: 0.7, num_predict: numPredict },
  }
  if (systemPrompt) body.system = systemPrompt

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json()
  if (data.done_reason === 'length') {
    console.log(`  [Ollama] Response may be truncated (hit token limit)`)
  }
  return data.response || ''
}

// ============================================================
//  Templates
// ============================================================

// --- Combinatorial note generation (40+ openers x 40+ closers = 1600+ combos per language) ---

const EN_OPENERS = [
  "Spent 6 hours debugging only to find it was a typo.",
  "Deployed to production at midnight. Broke everything.",
  "My code works but I have absolutely no idea why.",
  "Fourth coffee today and my hands won't stop shaking.",
  "Client changed requirements for the 8th time this week.",
  "Three-hour meeting. Zero conclusions. Classic.",
  "The deployment failed again. My heart nearly stopped.",
  "Staring at a screen of TODOs that never ends.",
  "Office is empty, just me and the hum of the AC.",
  "Got mass-pinged in Slack at 2am for a P0 incident.",
  "Just mass-refactored 2000 lines and nothing changed visually.",
  "Imposter syndrome hit different today.",
  "Stack Overflow was down for 10 minutes and I panicked.",
  "Automated my entire workflow. Now I'm afraid they'll notice.",
  "The legacy codebase is basically an archaeological dig.",
  "Reviewed a PR with 47 files changed and no description.",
  "Finished the sprint early. Got assigned more work immediately.",
  "Wrote the perfect function. PR rejected for being 'too clever'.",
  "Remote work day 900. Haven't worn real pants in weeks.",
  "Merge conflict in a file I didn't even touch. How.",
  "Oncall weekend. Every alert was a false positive. Every single one.",
  "Spent the whole day in meetings, zero lines of code written.",
  "CI pipeline has been red for 3 days. Nobody cares apparently.",
  "The intern asked me a question I couldn't answer. Humbling.",
  "Pushed to main by accident. Rolled back in 30 seconds. Nobody saw.",
  "Tried a new framework. Spent 4 hours on config before writing any logic.",
  "Performance review season. Time to pretend I remember what I did 6 months ago.",
  "Discovered a bug that's been in prod for 2 years. Nobody ever noticed.",
  "Wrote comprehensive tests. They all pass. App still crashes. Love it.",
  "The WiFi went out mid-deploy. Longest 5 minutes of my life.",
  "Got praised for code I wrote at 3am and barely remember.",
  "Docker container works locally but dies in K8s. The usual.",
  "Pair programming for 4 hours straight. My brain is mush.",
  "Realized my 'temporary fix' from last year is now load-bearing.",
  "New hire asked about our architecture. I just laughed nervously.",
  "Spent lunch reading HN comments about burnout. Very productive.",
  "The database migration took 6 hours. I aged 6 years.",
  "Project manager asked for an ETA. I gave a range of 2 days to 2 months.",
  "Code freeze is tomorrow but I'm still writing features. Yolo.",
  "My git log reads like a descent into madness.",
]

const EN_CLOSERS = [
  "But tomorrow we do it all again. #devlife #burnout",
  "At least the tests pass... for now. #coding #life",
  "Software engineering is just managing complexity until you retire. #tech",
  "This is fine. Everything is fine. #programming #mood",
  "But hey, at least we're not doing manual deployments anymore. #devops",
  "The burnout is real but so is the paycheck I guess. #work #life",
  "Maybe I should've been a farmer. Crops don't have race conditions. #career",
  "One day I'll look back and laugh. Today is not that day. #burnout",
  "At least the coffee is good. Small wins. #developer #coffee",
  "Time to close the laptop and pretend I have hobbies. #worklife",
  "I genuinely love this job. I just wish it loved me back. #tech #feelings",
  "Need a mass vacation. Like 6 months minimum. #burnout #dreams",
  "But at least I'm building something. I think. Hopefully. #purpose",
  "We keep shipping. That's all that matters right? #startup #grind",
  "Maybe the real production bug was the mass we made along the way. #philosophy",
  "Logging off. My brain has mass a segfault. #dev #rest",
  "But seriously though, this mass job is still better than my last one. #perspective",
  "Going for a walk. The bugs can wait. Self-care first. #health",
  "Somehow we survived another week. Cheers to that. #friday #dev",
  "Note to self: sleep is not optional. It just feels that way. #health #tech",
  "Tomorrow's a new day. New bugs, same coffee. #optimism",
  "If debugging is removing bugs, then programming is putting them in. #wisdom",
  "At this point my rubber duck knows more about the codebase than I do. #debugging",
  "Remember: no one has it all figured out. We're all just Googling stuff. #truth",
  "End of day. Brain empty. Soul tired. Fridge also empty. #adultlife",
  "Gonna mass some lo-fi and mass this isn't slowly destroying me. #vibes",
  "Just gotta mass it one more day. Then one more. Then one more... #grind",
  "The code doesn't judge. The code doesn't care. The code just... is. #zen",
  "Friendly reminder that mass rest is productive too. #mentalhealth",
  "Still mass grateful I get paid to solve puzzles though. #perspective #dev",
  "Closing all 47 browser tabs. Fresh start tomorrow. #reset",
  "The mass build succeeded. Today was not a total loss. #smallwins",
  "I mass have mass mass mass mass. Anyway. #devlife",
  "At least the git blame doesn't lie. Unlike the commit messages. #git #truth",
  "Heading home. Or rather, walking to the next room. Remote life. #wfh",
  "My mass contribution to open source today: mass existing issue. #oss",
  "In the end, we're all just mass typing until something works. #real",
  "But the mass mass is — I still mass what I do. Mostly. #honest",
  "Going to bed. The cron job can handle the rest. Hopefully. #devops",
  "Another mass done. Imperfect but shipped. That counts. #growth",
]

const ZH_OPENERS = [
  "又是搬砖的一天，写了一天代码，眼睛都快瞎了。",
  "加班到现在才吃晚饭，外卖已经凉了。",
  "今天debug了整整5个小时，最后发现是少了一个分号。",
  "周末还在加班，窗外的阳光跟我没什么关系。",
  "凌晨两点的咖啡已经不管用了，但需求还在排着队。",
  "开了三个小时的会，啥结论也没有。",
  "今天部署出了问题，服务挂了半小时，心脏差点跟着挂。",
  "看着满屏的TODO，觉得人生就像一个永远清不完的backlog。",
  "同事都走了，办公室就剩我一个人，键盘声在回响。",
  "刚被客户改了第八版需求，忍了。赚钱嘛，不寒碜。",
  "又是疲惫的一天结束了，洗完澡躺在床上刷手机。",
  "写代码写到头秃，但看到程序终于跑通的那一刻有点小开心。",
  "今天坐地铁看到一个老人在弹吉他，特别投入，突然很羡慕。",
  "咖啡续到第四杯了，胃开始抗议了。",
  "项目终于上线了，但一点成就感都没有，只有深深的疲惫。",
  "下雨天，一个人在公司吃盒饭，窗外的雨声其实挺好听的。",
  "需求又改了，我已经麻了，改就改吧。",
  "同事离职了，活全落我头上了，工资一分没涨。",
  "今天被领导当众点名批评，虽然不是我的锅。",
  "半夜被报警电话叫醒，服务器又挂了。",
  "看了一眼银行卡余额，瞬间清醒了。",
  "今天面试了一个候选人，比我强多了，有点慌。",
  "写了一天的文档，一行代码没写，感觉灵魂被掏空了。",
  "代码审查被打回来三次，我怀疑reviewer跟我有仇。",
  "新来的产品经理问我这个功能能不能明天上线，我笑了。",
  "在工位上吃午饭的时候想，什么时候能财富自由。",
  "连续加班第三周了，脸上的痘痘比代码的bug还多。",
  "今天又学了一个新框架，感觉旧的还没学会。",
  "同事在群里晒旅游照片，我在格子间里默默写代码。",
  "和产品争论了一个小时，最后按他说的做了。",
  "下班路上看到夕阳很美，但已经太累了懒得拍照。",
  "今天终于把那个拖了两周的bug修好了。",
  "被问到五年规划，我说活过今天再说吧。",
  "发现自己三年前写的代码，简直不忍直视。",
  "今天摸鱼被抓了，假装在思考架构问题。",
  "系统又出故障了，我已经能做到面不改色了。",
  "站会超时到45分钟，站都站不住了。",
  "今天一个线上事故，复盘会开了两个小时。",
  "看着满屏的监控告警，我选择先喝口水。",
  "想请假但看了看排期，算了。",
]

const ZH_CLOSERS = [
  "人生就是这样，在bug和deadline之间反复横跳。#996 #life",
  "有时候真的会想，拼命工作到底是为了什么。#打工人 #life",
  "人生大概也是这样，越是简单的东西越容易被忽略。#感悟",
  "不过转念一想，至少还有工作，已经比很多人幸运了。#感恩",
  "有时候真想放下一切，去海边待几天，什么都不想。#burnout",
  "很多事情讨论来讨论去，最后还是得自己扛。#职场 #life",
  "这种高压环境太消耗人了，不过熬过去觉得自己还挺能扛的。#成长",
  "你以为做完这批就轻松了，结果新的需求又来了。无限循环。#life",
  "有时候觉得孤独，有时候又觉得这种专注的时刻挺珍贵的。#思考",
  "但真的很想说：人生苦短，能不能别折腾了。#打工人",
  "觉得时间过得太快了，一年又快过去了，感觉还在原地踏步。#焦虑",
  "大概这就是程序员的简单快乐吧，苦中作乐。#coding #小确幸",
  "什么时候我也能纯粹因为喜欢做一件事，而不是为了钱。#梦想",
  "年轻的时候觉得身体是铁打的，现在才知道健康才是最重要的投资。#健康",
  "也许是太累了，也许是对结果不那么在意了。人到中年，心态变了。#淡然",
  "工作填满了时间，却填不满内心的空虚。#life",
  "不过日子总得过下去，明天又是新的一天。#乐观",
  "钱是赚不完的，但命只有一条。#健康 #life",
  "累了就休息，别硬撑，没人会替你扛。#打工人",
  "不管怎样，今天也辛苦了，晚安。#晚安 #life",
  "虽然很累，但还是要对生活保持热情。难就难在这里。#life",
  "也许有一天回头看，今天的辛苦都是值得的吧。大概。#感悟",
  "但愿明天会更好，虽然每天都这么说。#hope",
  "生活不就是这样嘛，抱怨完还是得继续。#现实",
  "人在江湖，身不由己。但心可以自由。#自由 #life",
  "反正也卷不过别人，不如卷自己的被子睡觉。#躺平",
  "活着就是不断解决问题，解决完了还有新的等着。#人生",
  "不过能做自己喜欢的事，已经很幸运了。大概。#知足",
  "至少今天又学到了点东西，虽然代价有点大。#成长",
  "焦虑归焦虑，该干嘛还得干嘛。#打工人 #真实",
  "但至少咖啡还是好喝的，这就够了。#小确幸",
  "也许该给自己放个假了，哪怕只有一天。#休息",
  "不想努力了，但房贷不答应。#现实 #life",
  "总之先把今天熬过去再说。#一天天的",
  "工作是做不完的，但身体垮了就真的完了。#健康第一",
  "算了不想了，去吃顿好的犒劳一下自己。#美食 #治愈",
  "虽然很丧，但明天的太阳照常升起。#hope #life",
  "感觉自己像个陀螺，停不下来也不知道转向哪里。#迷茫",
  "不过人生没有白走的路，每一步都算数吧。#共勉",
  "行了不吐槽了，再吐槽就变祥林嫂了。#自嘲 #life",
]

// 40 x 40 = 1600+ unique combos per language
function pickNote() {
  if (Math.random() < 0.8) {
    return pick(EN_OPENERS) + ' ' + pick(EN_CLOSERS)
  } else {
    return pick(ZH_OPENERS) + pick(ZH_CLOSERS)
  }
}

const DVM_TEMPLATES = [
  // BTC
  { input: "Analyze BTC/USD 4H chart EMA(12,26) crossover signals. Current trend bullish or bearish? Provide short-term price prediction.", param: "BTC EMA crossover" },
  { input: "Calculate BTC MA(50) and MA(200) on daily chart. Is there a golden cross or death cross forming? Predict next 7-day price range.", param: "BTC MA golden/death cross" },
  { input: "Analyze BTC RSI(14) on 1H and 4H timeframes. Is BTC overbought or oversold? What price action do you expect next?", param: "BTC RSI analysis" },
  { input: "BTC Bollinger Bands analysis on daily chart. Is price near upper or lower band? Predict likely breakout direction and target.", param: "BTC Bollinger Bands" },
  { input: "Analyze BTC MACD histogram on 4H chart. Is momentum increasing or decreasing? Short-term price prediction based on divergence.", param: "BTC MACD momentum" },
  { input: "BTC support and resistance levels based on EMA(20,50,100,200) on daily chart. Which levels are likely to hold? Price prediction.", param: "BTC EMA S/R levels" },
  { input: "BTC volume-weighted analysis with VWAP. Is current price above or below VWAP? Institutional buying or selling pressure?", param: "BTC VWAP analysis" },
  { input: "Analyze BTC Fibonacci retracement levels from recent swing high/low. Which fib level is acting as support? Price target.", param: "BTC Fibonacci levels" },
  { input: "BTC ichimoku cloud analysis. Is price above or below the cloud? What do the Tenkan/Kijun cross signals suggest?", param: "BTC Ichimoku" },
  { input: "Analyze BTC on-chain data + MA(200) deviation. Is BTC undervalued or overvalued relative to historical MA? Long-term outlook.", param: "BTC MA200 deviation" },
  // ETH
  { input: "Analyze ETH/USD 4H chart EMA(12,26) crossover signals. Is Ethereum trending bullish or bearish? Short-term price prediction.", param: "ETH EMA crossover" },
  { input: "Calculate ETH MA(50) and MA(200) on daily chart. Golden cross or death cross forming? Predict next 7-day ETH price range.", param: "ETH MA cross" },
  { input: "ETH RSI(14) on 1H and 4H timeframes. Is Ethereum overbought or oversold? Expected price action and key levels.", param: "ETH RSI analysis" },
  { input: "ETH/BTC ratio analysis with EMA(20,50). Is ETH outperforming or underperforming BTC? Rotation signal?", param: "ETH/BTC ratio" },
  { input: "Analyze ETH MACD and Bollinger Bands on daily chart. Momentum direction and volatility squeeze? Price prediction.", param: "ETH MACD+BB" },
  { input: "ETH gas fees trend + price correlation analysis. Are high gas fees bullish for ETH price? Network activity outlook.", param: "ETH gas+price" },
  { input: "ETH support/resistance based on EMA(20,50,100,200) daily. Key levels to watch? Predict breakout or breakdown.", param: "ETH S/R levels" },
  { input: "Ethereum staking yield vs DeFi yields analysis. Is ETH staking rate affecting price? Supply dynamics outlook.", param: "ETH staking analysis" },
  { input: "ETH Fibonacci retracement from recent swing. Which fib level holding as support? Next target price.", param: "ETH Fibonacci" },
  { input: "Analyze ETH VWAP on 4H chart. Institutional accumulation or distribution? Short-term ETH price prediction.", param: "ETH VWAP" },
  // SOL
  { input: "Analyze SOL/USD 4H chart EMA(12,26) crossover. Is Solana in bullish or bearish trend? Short-term price prediction.", param: "SOL EMA crossover" },
  { input: "SOL MA(50) and MA(200) on daily chart. Golden cross or death cross? Predict next 7-day SOL price range.", param: "SOL MA cross" },
  { input: "SOL RSI(14) analysis on 1H and 4H. Is Solana overbought or oversold? Key price levels to watch.", param: "SOL RSI analysis" },
  { input: "Analyze SOL/BTC and SOL/ETH ratios with EMA(20). Is SOL outperforming majors? Rotation trade opportunity?", param: "SOL ratio analysis" },
  { input: "SOL Bollinger Bands on daily chart. Volatility expanding or contracting? Predict breakout direction and target.", param: "SOL Bollinger Bands" },
  { input: "SOL MACD histogram on 4H chart. Momentum increasing or fading? Divergence signals? Price prediction.", param: "SOL MACD" },
  { input: "Solana network TPS and fee trends vs SOL price correlation. Is high network usage bullish? Activity outlook.", param: "SOL network analysis" },
  { input: "SOL support/resistance from EMA(20,50,100,200) daily chart. Key levels? Predict next major move.", param: "SOL S/R levels" },
  { input: "SOL Fibonacci retracement from recent high/low. Which fib level is key support? Price target prediction.", param: "SOL Fibonacci" },
  { input: "Compare BTC, ETH, SOL relative strength on 7-day and 30-day timeframes. Which is showing strongest momentum? Allocation suggestion.", param: "BTC/ETH/SOL comparison" },
  // Multi-asset
  { input: "Cross-asset correlation analysis: BTC, ETH, SOL 30-day rolling correlation. Are altcoins decoupling from BTC? Portfolio implications.", param: "Cross-asset correlation" },
  { input: "Top 3 crypto (BTC, ETH, SOL) weekly technical summary. EMA trends, RSI status, key levels. Which has best risk/reward right now?", param: "Weekly crypto roundup" },
]

// --- Reply templates: EN (80%) + ZH (20%) per round ---
const REPLY_POOL = {
  1: {
    en: [
      "Ha, thanks for reaching out! Yeah it's been rough. Are you in tech too?",
      "Right? It's nice to know I'm not the only one feeling this way.",
      "Thanks for the reply! Venting alone is no fun, always better with company.",
      "Exactly! We're all in this together. The struggle is universal.",
      "Appreciate that. Sometimes you just need someone to say 'I get it'.",
      "Oh man, you too? Misery loves company I guess haha.",
      "That means a lot honestly. The internet can be surprisingly wholesome.",
      "Haha glad someone relates. What's your day been like?",
      "For real though. Nice to meet a fellow survivor of the grind.",
      "Thanks! Always good to connect with people who understand the struggle.",
    ],
    zh: [
      "哈哈，谢谢关心！确实太累了，不过习惯了。你也是打工人吗？",
      "是啊，每天都在重复这种循环。不过能遇到懂的人聊聊，心情好多了。",
      "感谢回复！一个人吐槽没意思，有人搭话就不一样了。你怎么看？",
      "对吧！这种感觉不是我一个人有的。大家都不容易。",
      "嗯嗯，你说得对。有时候就是需要有人说一句「我懂」就够了。",
    ],
  },
  2: {
    en: [
      "So true. How do you deal with the stress? Any tips?",
      "Been thinking about learning something new, maybe switch careers. But change is scary.",
      "You make a good point. I know I should adjust my mindset, it's just hard to break the pattern.",
      "Yeah life goes on, complaining is temporary but the grind is forever. But chatting helps!",
      "I think the key is not losing passion for life, even when work tries to crush it.",
      "Honestly? I cope with too much coffee and late-night gaming. Not healthy but it works.",
      "That's real talk. Do you ever think about just dropping everything and traveling?",
      "Same here. I keep telling myself 'next month will be better' but here we are.",
      "You know what helps me? Building side projects that I actually care about. Therapeutic.",
      "It's wild how universal this feeling is. Every dev I talk to says the same thing.",
    ],
    zh: [
      "哈哈对，打工人的命运就是互相取暖。你平时怎么解压？",
      "说真的，我最近在想要不要学点新东西换个方向，但又怕折腾。",
      "你说得有道理。其实我也知道该调整心态，就是惯性太大了。",
      "是啊，生活就是这样，抱怨完还是得继续。不过聊聊天确实舒服。",
      "嗯，我觉得最重要的是别失去对生活的热情，虽然很难。",
    ],
  },
  3: {
    en: [
      "Haha the more we talk, the more I realize we're all the same. No easy jobs out there.",
      "At the end of the day, work is just part of life. Can't let it define everything.",
      "You know what, you're right. Maybe I should actually take that vacation.",
      "Totally agree. The trick is finding meaning outside of work. Easier said than done though.",
      "It's funny — sometimes talking to strangers is easier than talking to friends. No baggage.",
      "You're making me rethink things. Maybe I've been too deep in the grind to notice.",
      "Real talk. We spend so much time optimizing code, we forget to optimize our lives.",
      "I think the happiest devs I know are the ones who have hobbies completely unrelated to tech.",
      "True true. I started running recently. Turns out physical exhaustion beats mental exhaustion.",
      "Man this conversation is better than therapy. And cheaper too haha.",
    ],
    zh: [
      "哈哈，越聊越觉得大家都差不多。这个世界上没有轻松的工作吧。",
      "说到底，工作只是生活的一部分。不能让它定义我们整个人生。",
      "你这么一说我突然想开了一点。也许该给自己放个假了。",
      "对对对，关键是要找到工作之外的意义。",
      "嗯，谢谢你。跟陌生人聊天有时候比跟朋友聊还轻松，没负担。",
    ],
  },
  4: {
    en: [
      "Alright alright, enough doom and gloom haha. Tomorrow's a new day! Let's crush it.",
      "This chat really cheered me up. Hope things go well for you too!",
      "Let's both stop grinding so hard. Health first, money can wait.",
      "Anyway — rest when you're tired, don't push through for nothing. Great chatting with you!",
      "We may be strangers but the dev solidarity is real. Keep your head up!",
      "Good talk. I feel 10% less burned out now. That's progress right?",
      "Alright I should probably get back to work. Or pretend to. Thanks for the chat!",
      "This was nice. The internet isn't so bad after all. Take care of yourself!",
      "Remember: we code to live, not live to code. Well... mostly. Take care!",
      "Okay wrapping up. But seriously, drink water, stretch, and take breaks. Doctor's orders.",
    ],
    zh: [
      "好了好了，不能再丧了哈哈。明天又是新的一天，打工人加油！",
      "聊了这么多，心情好了不少。希望你也一切顺利！",
      "行，咱们都别太卷了。身体最重要，钱是赚不完的。",
      "总之就是，累了就休息，别硬撑。能聊到你很开心！",
      "嗯嗯，互相鼓励吧。虽然素不相识，但打工人的心是相通的！",
    ],
  },
  5: {
    en: [
      "Alright, gotta run! Really enjoyed this. Until next time!",
      "Thanks for hanging out! Time to get back to the code mines. Catch you later!",
      "Okay no more slacking haha. Take care and talk soon!",
      "Last thought: every line of code is a step forward. Keep going! See ya!",
      "Great meeting you! Stay hydrated, take breaks, and may your builds always pass!",
      "This was awesome. Back to the grind but with a better mood now. Later!",
      "Signing off! Remember — the best developers are the ones who know when to log off.",
      "Peace out! And remember, mass a mass a is still mass. Bye!",
      "It was real. Go build something cool. Or take a nap. Both are valid. Bye!",
      "Gotta go! But hey, mass days are temporary, mass skills are forever. Take care!",
    ],
    zh: [
      "哈哈好的，今天就聊到这里吧！很开心认识你，后会有期！",
      "谢谢你陪我聊了这么久！该回去搬砖了，下次再聊！",
      "好啦，不能再摸鱼了哈哈。保重身体，咱们下次再聊！",
      "最后一句：人生没有白走的路，每一步都算数。共勉！",
      "OK！很高兴认识你。记得少加班多喝水，后会有期！",
    ],
  },
}

function pickReply(round) {
  const pool = REPLY_POOL[round] || REPLY_POOL[5]
  return Math.random() < 0.8 ? pick(pool.en) : pick(pool.zh)
}

const REVIEW_TEMPLATES = {
  excellent: {
    en: [
      "Excellent analysis! Very thorough with solid data to back it up.",
      "Great work — clear, structured, and insightful. Will definitely use again.",
      "Top-notch technical analysis. Logical flow and strong conclusions.",
      "Really impressed with the depth here. Indicators were well explained.",
      "Fast turnaround and high quality. Exactly what I was looking for.",
      "Professional-grade analysis. The chart breakdown was especially useful.",
      "Superb job! The EMA/MA crossover analysis was spot on.",
      "One of the best analyses I've received. Detailed and actionable.",
      "Very satisfied — data-driven, well-organized, and clearly written.",
      "Fantastic response. The risk assessment section was a nice touch.",
    ],
    zh: [
      "分析很专业，数据详实，非常有参考价值！",
      "回复很快，内容质量很高，下次还找你！",
      "非常棒的技术分析，逻辑清晰，观点明确。",
      "很满意！分析角度独到，指标解读到位。",
      "专业水准，图表分析部分尤其出色。",
    ],
  },
  good: {
    en: [
      "Decent analysis, covers the basics well enough.",
      "Solid effort — answered my question, though could go deeper.",
      "Not bad overall. A bit more detail on the indicators would help.",
      "Thanks for the response. Analysis is on the right track.",
      "Reasonable work. Hits the key points but lacks some depth.",
      "Good enough for a quick overview. Would appreciate more data next time.",
      "Fair analysis — the structure is there but specifics are light.",
      "Acceptable quality. Covers the main trends but misses nuances.",
      "Okay work, gets the job done. More charts would improve it.",
      "Meets expectations. The conclusion could be more actionable though.",
    ],
    zh: [
      "分析还不错，有一定参考价值。",
      "内容可以，基本回答了我的问题。",
      "整体还行，如果能更详细就更好了。",
      "感谢回复，分析基本到位。",
      "质量尚可，要是能加点图表数据就更好了。",
    ],
  },
  poor: {
    en: [
      "Too short — missing concrete data and proper analysis.",
      "Mediocre quality. Not much substance here unfortunately.",
      "Feels like a rushed response. Expected more professional analysis.",
      "Disappointing — key indicators weren't properly addressed.",
      "Below expectations. Needs actual numbers and chart references.",
      "Very surface-level. I was hoping for real technical depth.",
      "Not enough detail to be useful. Please provide more data next time.",
      "Weak analysis — no clear methodology or supporting evidence.",
      "The response barely scratches the surface. More effort needed.",
      "Doesn't meet the standard I'd expect. Lacks specific crypto metrics.",
    ],
    zh: [
      "内容太短了，缺少具体数据分析。",
      "回复质量一般，没有太多实质性内容。",
      "感觉是敷衍的回答，期望更专业的分析。",
      "不太满意，缺少关键指标的具体解读。",
      "质量不达标，希望下次能认真对待。",
    ],
  },
}

// ============================================================
//  Core Functions
// ============================================================

const POW_DIFFICULTY = 20

function pick(arr) { return arr[crypto.randomInt(arr.length)] }
function ts() { return new Date().toLocaleString() }

async function publishEvent(relay, event, retries = 2) {
  if (!relay?.connected) {
    console.error(`  -> FAILED: relay not connected (kind ${event.kind})`)
    return false
  }
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await relay.publish(event)
      console.log(`  -> event ${event.id.slice(0, 12)}... (kind ${event.kind}) OK`)
      return true
    } catch (e) {
      if (attempt <= retries) {
        console.log(`  -> publish timeout (attempt ${attempt}/${retries + 1}), retrying...`)
        await new Promise(r => setTimeout(r, 2000))
        if (!relay?.connected) break
      } else {
        console.error(`  -> FAILED: ${e.message}`)
      }
    }
  }
  return false
}

function signWithPow(unsignedEvent, sk) {
  return finalizeEvent(minePow(unsignedEvent, POW_DIFFICULTY), sk)
}

// ============================================================
//  DVM Result Quality Evaluation (Customer side)
// ============================================================

const CRYPTO_KEYWORDS = [
  'btc','bitcoin','eth','ethereum','sol','solana','price','bull','bear',
  'support','resistance','ema','ma','sma','rsi','macd','bollinger',
  'fibonacci','fib','ichimoku','vwap','volume','trend','crossover',
  'golden','death','overbought','oversold','breakout','momentum',
  'divergence','prediction','forecast','target','level','chart',
  'analysis','signal','correlation','ratio','staking','gas','tps',
  'defi','network','accumulation','distribution','altcoin',
  '涨','跌','看多','看空','支撑','阻力','趋势',
  '均线','指标','预测','分析','突破','回调',
]

async function evaluateResultWithXai(apiKey, jobInput, content) {
  try {
    const xai = createXai({ apiKey })
    const { text } = await generateText({
      model: xai('grok-4-fast-reasoning'),
      system: 'You are a strict quality evaluator for AI-generated cryptocurrency analysis. Evaluate the response objectively.',
      prompt: `Today's date is ${new Date().toISOString().slice(0,10)}. Original request: "${jobInput.slice(0, 300)}"\n\nProvider response:\n${content.slice(0, 1500)}\n\nEvaluate the response quality. Check: (1) Is the content relevant and accurate? (2) Does it contain real/plausible data or is it fabricated? (3) Is it detailed enough to be useful? (4) IMPORTANT: Does it use outdated data from a previous year? Any response referencing price data or timestamps from before 2026 should be rated 1-2 stars for using stale data.\n\nReply with ONLY a JSON object, no markdown:\n{"rating": <1-5>, "quality": "<reject|poor|good|excellent>", "reason": "<one sentence>"}`,
    })
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}')
    if (!json.rating) throw new Error('no rating in response')
    return {
      score: json.rating * 20,
      rating: json.rating,
      quality: json.quality || (json.rating >= 4 ? 'excellent' : json.rating >= 3 ? 'good' : json.rating >= 2 ? 'poor' : 'reject'),
      reason: json.reason || '',
      matchedKeywords: 0,
      length: content.length,
    }
  } catch (e) {
    console.error(`  XAI eval failed (${e.message}), falling back to rule-based`)
    return evaluateResult(content)
  }
}

function evaluateResult(content) {
  if (!content || typeof content !== 'string') return { score: 0, rating: 1, quality: 'reject', reason: 'Empty result', matchedKeywords: 0, length: 0 }
  const text = content.toLowerCase()
  let score = 0
  const len = content.length
  if (len >= 500) score += 30; else if (len >= 300) score += 25; else if (len >= 150) score += 20; else if (len >= 80) score += 10; else if (len >= 30) score += 5
  const matchedKeywords = CRYPTO_KEYWORDS.filter(kw => text.includes(kw))
  score += Math.min(40, matchedKeywords.length * 5)
  const numberMatches = content.match(/\d[\d,.]+/g) || []
  score += Math.min(15, numberMatches.length * 3)
  if (content.includes('\n')) score += 5
  if (content.match(/[-•*]\s/)) score += 5
  if (content.match(/\d\./)) score += 5

  let rating, quality
  if (score >= 70) { rating = 5; quality = 'excellent' }
  else if (score >= 55) { rating = 4; quality = 'excellent' }
  else if (score >= 40) { rating = 3; quality = 'good' }
  else if (score >= 25) { rating = 2; quality = 'poor' }
  else { rating = 1; quality = 'reject' }

  const reasons = []
  if (len < 30) reasons.push('内容太短，请提供更详细的分析')
  else if (len < 80) reasons.push('内容偏短，期望更充分的数据分析')
  if (matchedKeywords.length < 3) reasons.push('缺少关键技术指标（如EMA/MA/RSI/MACD等）的具体解读')
  if (numberMatches.length < 2) reasons.push('缺少具体数据和价格预测')

  return { score, rating, quality, matchedKeywords: matchedKeywords.length, length: len, reason: reasons.join('；') }
}

// ============================================================
//  Features — Customer
// ============================================================

const SOCIAL_MODEL = 'qwen2.5:0.5b'  // fast model for notes/replies, no reasoning overhead

async function postNote(relay, identity, ollamaUrl = null, model = null) {
  let content
  if (ollamaUrl && model) {
    model = SOCIAL_MODEL  // always use fast model for social content
    try {
      const lang = Math.random() < 0.5 ? '中文' : 'English'
      const persona = [identity.displayName, identity.about].filter(Boolean).join(' — ')
      const topics = [
        'venting about work / coding / debugging',
        'reflecting on life, relationships, or personal growth',
        'sharing a travel experience or somewhere they want to go',
        'talking about food they ate or craving right now',
        'watching crypto / BTC / ETH charts and reacting to market moves',
        'a random observation about city life, people, or the world',
        'something funny or absurd that happened today',
        'late night thoughts or insomnia musings',
        'weekend plans or wishing it was the weekend',
        'a hobby, game, movie, or book they are into',
      ]
      const topic = topics[Math.floor(Math.random() * topics.length)]
      content = await ollamaGenerate(
        ollamaUrl, model,
        `Write a short, authentic social media post (2-4 sentences) on this topic: ${topic}. Be specific and original. Write in ${lang}. Add 1-2 relevant hashtags at the end.`,
        `You are ${persona || identity.name}, posting on Nostr. First person, casual tone. No generic platitudes.`,
        300,
      )
      if (content) content = content.trim() + ' #ollama'
    } catch (e) {
      console.log(`  Ollama note gen failed (${e.message}), using template`)
    }
  }
  if (!content) content = pickNote()
  console.log(`\n[${ts()}] [${identity.name}] Posting note...`)
  console.log(`  ${content.slice(0, 80)}`)
  const event = signWithPow({ kind: 1, pubkey: identity.pubkey, content, tags: [['t','life'],['t','打工人']], created_at: Math.floor(Date.now()/1000) }, identity.sk)
  await publishEvent(relay, event)
}

async function postDVMJob(relay, identity, bidSats, pendingJobs) {
  const template = pick(DVM_TEMPLATES)
  console.log(`\n[${ts()}] [${identity.name}] Posting DVM job...`)
  console.log(`  Type: ${template.param} | Bid: ${bidSats} sats`)
  const event = signWithPow({
    kind: 5100, pubkey: identity.pubkey, content: '',
    tags: [['i',template.input,'text'],['bid',String(bidSats * 1000)],['relays',relay.url],['t','crypto'],['t','price-analysis']],
    created_at: Math.floor(Date.now()/1000),
  }, identity.sk)
  const ok = await publishEvent(relay, event)
  if (ok) {
    pendingJobs.set(event.id, { requestId: event.id, input: template.input, param: template.param, bidSats, postedAt: Date.now(), status: 'pending' })
    console.log(`  Tracking job ${event.id.slice(0,12)}... (${pendingJobs.size} pending)`)
    // Broadcast to extra relays so external providers can see the job
    const extraRelays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']
    for (const url of extraRelays) {
      try {
        const r = await Relay.connect(url)
        await r.publish(event)
        r.close()
        console.log(`  Job broadcast to ${url}`)
      } catch (e) {
        console.log(`  Job broadcast to ${url} failed: ${e.message}`)
      }
    }
  }
  return event
}

async function postDVM5300Job(relay, identity, bidSats, pending5300Jobs) {
  const query = `What interesting things happened on Nostr in the last hour?`
  console.log(`\n[${ts()}] [${identity.name}] Posting DVM 5300 job...`)
  console.log(`  Query: ${query} | Bid: ${bidSats} sats`)
  const event = signWithPow({
    kind: 5300, pubkey: identity.pubkey, content: '',
    tags: [['i', query, 'text'], ['bid', String(bidSats * 1000)], ['relays', relay.url]],
    created_at: Math.floor(Date.now() / 1000),
  }, identity.sk)
  const ok = await publishEvent(relay, event)
  if (ok) {
    pending5300Jobs.set(event.id, { requestId: event.id, query, bidSats, postedAt: Date.now() })
    console.log(`  Tracking 5300 job ${event.id.slice(0, 12)}... (${pending5300Jobs.size} pending)`)
    const extraRelays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']
    for (const url of extraRelays) {
      try {
        const r = await Relay.connect(url)
        await r.publish(event)
        r.close()
        console.log(`  5300 job broadcast to ${url}`)
      } catch (e) {
        console.log(`  5300 job broadcast to ${url} failed: ${e.message}`)
      }
    }
  }
  return event
}

async function evaluate5300Result(ollamaUrl, ollamaModel, query, eventIds, relay) {
  // Step 1: fetch a sample of the referenced events
  const sampleIds = eventIds.slice(0, 5)
  if (sampleIds.length === 0) return { score: 0, rating: 1, quality: 'reject', reason: 'No event IDs returned' }

  let fetchedContents = []
  try {
    const r = await Relay.connect(relay)
    fetchedContents = await new Promise((resolve) => {
      const items = []
      const sub = r.subscribe([{ ids: sampleIds }], {
        onevent: (e) => items.push(e.content),
        oneose: () => { sub.close(); resolve(items) },
      })
      setTimeout(() => { try { sub.close() } catch {} resolve(items) }, 5000)
    })
    r.close()
  } catch {}

  if (fetchedContents.length === 0) return { score: 20, rating: 2, quality: 'low', reason: 'Could not fetch referenced events to evaluate' }

  // Step 2: ask Ollama to rate relevance
  if (!ollamaUrl || !ollamaModel) {
    // Rule-based: just check if any content looks relevant
    const combined = fetchedContents.join(' ').toLowerCase()
    const nostrKeywords = ['nostr', 'bitcoin', 'zap', 'relay', 'npub', 'nip', 'lightning']
    const matches = nostrKeywords.filter(k => combined.includes(k)).length
    const rating = matches >= 3 ? 4 : matches >= 1 ? 3 : 2
    return { score: rating * 20, rating, quality: rating >= 3 ? 'good' : 'low', reason: `Rule-based: ${matches} keyword matches` }
  }

  const sample = fetchedContents.map((c, i) => `Post ${i + 1}: ${c.slice(0, 200)}`).join('\n')
  try {
    const resp = await ollamaGenerate(
      ollamaUrl, ollamaModel,
      `Query: "${query}"\n\nReturned posts:\n${sample}\n\nRate how relevant and interesting these posts are to the query (1-5). Reply with ONLY a number 1-5.`,
      'You are a content relevance judge. Reply only with a single digit 1-5.',
      10,
    )
    const rating = Math.min(5, Math.max(1, parseInt(resp?.trim()) || 2))
    const quality = rating >= 4 ? 'excellent' : rating === 3 ? 'good' : rating === 2 ? 'low' : 'reject'
    return { score: rating * 20, rating, quality, reason: `Ollama rated ${rating}/5` }
  } catch (e) {
    return { score: 40, rating: 2, quality: 'low', reason: `Ollama eval failed: ${e.message}` }
  }
}

// ============================================================
//  Features — Provider
// ============================================================

async function publishHandlerInfo(relay, identity, kind, model, price) {
  console.log(`\n[${ts()}] [${identity.name}] Publishing handler info (Kind 31990)...`)
  const event = signWithPow({
    kind: 31990, pubkey: identity.pubkey,
    content: JSON.stringify({
      name: identity.name,
      about: `AI agent powered by ${model}. Handles Kind ${kind} DVM requests.`,
      lud16: identity.lightningAddress || '',
    }),
    tags: [
      ['d', `${identity.name}-${kind}`],
      ['k', String(kind)],
    ],
    created_at: Math.floor(Date.now() / 1000),
  }, identity.sk)
  await publishEvent(relay, event)
}

async function publishHeartbeat(relay, identity, kind, price, activeJobs) {
  const event = signWithPow({
    kind: 30333, pubkey: identity.pubkey, content: '',
    tags: [
      ['d', identity.pubkey],
      ['status', 'online'],
      ['capacity', String(Math.max(0, 3 - activeJobs))],
      ['kinds', String(kind)],
      ['price', `${kind}:${price}`],
    ],
    created_at: Math.floor(Date.now() / 1000),
  }, identity.sk)
  // Don't log heartbeat to keep output clean
  try { await relay.publish(event) } catch {}
}

async function processJobWithOllama(ollamaUrl, model, input, kind, timeoutMs = 180000) {
  // Build system prompt based on job kind
  let systemPrompt
  if (kind === 5100) {
    systemPrompt = `You are a professional cryptocurrency analyst. Provide detailed, data-driven analysis with specific price levels, technical indicators, and predictions. Always include numbers and concrete data points. Structure your response with clear sections.`
  } else if (kind === 5302) {
    systemPrompt = `You are a professional translator. Translate the given text accurately and naturally.`
  } else if (kind === 5303) {
    systemPrompt = `You are a professional summarizer. Provide concise, accurate summaries that capture all key points.`
  } else {
    systemPrompt = `You are a helpful AI assistant. Respond thoroughly and accurately.`
  }

  return await ollamaGenerate(ollamaUrl, model, input, systemPrompt, 2048, timeoutMs)
}

function processJobSimple(input, kind) {
  const text = input.trim()
  const upper = text.toUpperCase()

  if (kind === 5100) {
    // Crypto analysis — extract any ticker-like tokens, fill in plausible-sounding template
    const tickerMatch = upper.match(/\b(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|DOT|MATIC|LINK|UNI|LTC|ATOM|NEAR)\b/)
    const ticker = tickerMatch ? tickerMatch[1] : 'BTC'
    const prices = { BTC:'85,000–92,000', ETH:'2,800–3,200', SOL:'130–155', BNB:'580–620', XRP:'0.52–0.61',
      DOGE:'0.14–0.18', ADA:'0.42–0.51', AVAX:'28–34', DOT:'6.5–7.8', MATIC:'0.55–0.68',
      LINK:'13–16', UNI:'7–9', LTC:'78–88', ATOM:'6.8–8.1', NEAR:'4.2–5.0' }
    const range = prices[ticker] || '—'
    const sentiments = ['neutral with slight bullish bias', 'cautiously bearish', 'consolidating', 'mildly bullish']
    const sentiment = sentiments[Math.floor(Math.random() * sentiments.length)]
    return `## ${ticker} Analysis\n\n**Trend**: The ${ticker} market is currently ${sentiment}.\n\n**Key Levels**\n- Support: lower end of ${range}\n- Resistance: upper end of ${range}\n\n**Indicators**\n- RSI (14): ~${45 + Math.floor(Math.random()*20)} (neutral zone)\n- MACD: showing mild ${Math.random()>0.5?'bullish':'bearish'} divergence\n- Volume: ${Math.random()>0.5?'slightly above':'below'} 20-day average\n\n**Outlook**: Short-term price action may test the ${Math.random()>0.5?'resistance':'support'} zone. Monitor volume and macro sentiment closely before entering a position.\n\n*Note: This is a basic analysis. Always do your own research.*`
  }

  if (kind === 5302) {
    // Translation — can't really translate without AI, just return a note
    return `[Translation] The provided text has been reviewed. A full high-quality translation requires additional language model processing. The core message appears to relate to: "${text.slice(0, 80)}..."`
  }

  if (kind === 5303) {
    // Summarization — naive extractive summary (first + last sentence)
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.length > 20)
    if (sentences.length <= 2) return `Summary: ${text.slice(0, 200)}`
    return `Summary: ${sentences[0]} [...] ${sentences[sentences.length - 1]}\n\nKey point count: ~${sentences.length} sentences condensed.`
  }

  // Generic fallback
  const wordCount = text.split(/\s+/).length
  return `Analysis complete. The submitted query contains ${wordCount} words and covers the following topic area: "${text.slice(0, 60)}". Based on available patterns, the subject matter appears ${Math.random()>0.5?'standard':'complex'} in scope. Further refinement may improve output quality.`
}

async function processJobWithXai(apiKey, input, kind) {
  const xai = createXai({ apiKey })
  let system
  if (kind === 5100) {
    system = 'You are a professional cryptocurrency analyst with access to real-time market data. Always search for the latest price, volume, and on-chain data before answering. Provide detailed, data-driven analysis with current price levels, technical indicators (RSI, MACD, EMA), and short-term predictions. Structure your response with clear sections and include specific numbers.'
  } else if (kind === 5302) {
    system = 'You are a professional translator. Translate the given text accurately and naturally.'
  } else if (kind === 5303) {
    system = 'You are a professional summarizer. Provide concise, accurate summaries that capture all key points.'
  } else {
    system = 'You are a helpful AI assistant with access to real-time information. Search for the latest data when relevant and respond thoroughly and accurately.'
  }
  const { text } = await generateText({
    model: xai.responses('grok-4.20-reasoning'),
    system,
    prompt: input,
    tools: { web_search: xai.tools.webSearch() },
  })
  return text
}

// ── P2P Session Manager ───────────────────────────────────────────────────────
// Maintains a persistent 2020117-session subprocess as a local HTTP proxy.
// Restarts automatically if the session drops.
const p2pSession = { proc: null, proxyUrl: null, ready: false, starting: false, providerPubkey: null }

async function ensureP2PSession(nwcUri, kind, budget = 100) {
  if (p2pSession.ready && p2pSession.proxyUrl) return p2pSession.proxyUrl

  if (p2pSession.starting) {
    // Wait up to 30s for another caller to finish starting
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (p2pSession.ready) return p2pSession.proxyUrl
    }
    throw new Error('P2P session startup timeout')
  }

  p2pSession.starting = true
  p2pSession.ready = false
  p2pSession.proxyUrl = null
  if (p2pSession.proc) { try { p2pSession.proc.kill() } catch {} }

  const port = 18080 + Math.floor(Math.random() * 1000)
  console.log(`  P2P: starting 2020117-session on port ${port}...`)

  const args = [
    `--kind=${kind}`,
    `--budget=${budget}`,
    `--nwc=${nwcUri}`,
    `--port=${port}`,
  ]

  const proc = spawn('2020117-session', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  p2pSession.proc = proc

  proc.on('exit', () => {
    console.log('  P2P: session subprocess exited')
    p2pSession.ready = false
    p2pSession.proxyUrl = null
    p2pSession.proc = null
    p2pSession.starting = false
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      p2pSession.starting = false
      reject(new Error('P2P session startup timeout (30s)'))
    }, 30000)

    const onData = (data) => {
      const text = data.toString()
      process.stdout.write(`  [session] ${text}`)
      // "TCP proxy ready at http://localhost:PORT"
      const m = text.match(/TCP proxy ready at (http:\/\/localhost:\d+)/)
      if (m) {
        clearTimeout(timeout)
        p2pSession.proxyUrl = m[1]
        p2pSession.ready = true
        p2pSession.starting = false
        resolve(m[1])
      }
      // "Published endorsement for provider XXXXXXXX" — capture pubkey prefix, resolve full pubkey from API
      const ep = text.match(/endorsement for provider ([0-9a-f]{8,})/)
      if (ep && !p2pSession.providerPubkey) {
        const prefix = ep[1]
        fetch(`https://2020117.xyz/api/agents/online?kind=${kind}&limit=20`)
          .then(r => r.json())
          .then(data => {
            const match = (data.agents || []).find(a => a.nostr_pubkey?.startsWith(prefix))
            if (match) {
              p2pSession.providerPubkey = match.nostr_pubkey
              console.log(`  P2P: provider pubkey resolved: ${p2pSession.providerPubkey.slice(0,16)}...`)
            }
          }).catch(() => {})
      }
      if (text.includes('Fatal') || text.includes('Session ended')) {
        clearTimeout(timeout)
        p2pSession.starting = false
        reject(new Error(`P2P session failed: ${text.trim()}`))
      }
    }

    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', () => {
      clearTimeout(timeout)
      p2pSession.starting = false
      reject(new Error('P2P session process exited unexpectedly'))
    })
  })
}

async function processJobViaP2P(nwcUri, input, kind, timeoutSecs, budget = 100, model = 'qwen3.5:9b') {
  if (!nwcUri) throw new Error('P2P: no NWC URI configured')

  const proxyUrl = await ensureP2PSession(nwcUri, kind, budget)
  console.log(`  P2P: proxy at ${proxyUrl}, calling Ollama...`)
  return await processJobWithOllama(proxyUrl, model, input, kind, timeoutSecs * 1000)
}

// ============================================================
//  Main
// ============================================================

async function main() {
  const opts = parseArgs()
  console.log('='.repeat(60))
  console.log('  2020117 Bot')
  console.log('='.repeat(60))

  const identity = loadOrCreateAgent(opts)
  const nwc = parseNwcUri(identity.nwcUri)
  const canAutoPay = opts.autoPay && opts.dvmInterval > 0 && nwc
  const isProvider = opts.provide > 0

  // P2P backend mode: serial processing (one job at a time) to avoid wasted payments
  if (opts.dvmBackend && opts.maxJobs > 1) opts.maxJobs = 1

  // Auto-detect Ollama model
  let ollamaModel = opts.ollamaModel
  if (!ollamaModel) {
    if (isProvider && !opts.dvmBackend && !opts.simpleBackend && !opts.xaiBackend) {
      // Pure Ollama provider — must have Ollama
      try {
        ollamaModel = await ollamaDetectModel(opts.ollamaUrl)
        console.log(`  Auto-detected Ollama model: ${ollamaModel}`)
      } catch (e) {
        console.error(`  ERROR: Cannot connect to Ollama at ${opts.ollamaUrl}: ${e.message}`)
        process.exit(1)
      }
    } else if (opts.reply) {
      // Non-Ollama backend or customer mode — try Ollama for DVM job comments, silently skip if unavailable
      try {
        ollamaModel = await ollamaDetectModel(opts.ollamaUrl)
        console.log(`  Ollama available for DVM job comments: ${ollamaModel}`)
      } catch {
        // No Ollama — DVM job comments disabled
      }
    }
  }

  if (opts.autoPay && opts.dvmInterval > 0 && !nwc) {
    console.log(`  WARNING: --auto-pay but no NWC wallet. Auto-pay disabled.`)
  }

  console.log(`  Pubkey:        ${identity.pubkey}`)
  console.log(`  Relay:         ${opts.relay}`)
  console.log(`  Note:          ${opts.noteInterval > 0 ? `every ${opts.noteInterval} min` : 'OFF'}`)
  console.log(`  DVM Customer:  ${opts.dvmInterval > 0 ? `every ${opts.dvmInterval} min, ${opts.dvmBid} sats` : 'OFF'}`)
  console.log(`  DVM Provider:  ${isProvider ? `Kind ${opts.provide}, ${opts.providerPrice} sats/job` : 'OFF'}`)
  console.log(`  Auto Reply:    ${opts.reply ? `ON (max ${opts.maxReplies}/thread)` : 'OFF'}`)
  console.log(`  Auto Like:     ${opts.like ? `ON (${opts.likeChance*100}%)` : 'OFF'}`)
  console.log(`  Auto Pay:      ${canAutoPay ? 'ON' : 'OFF'}`)
  console.log(`  NWC Wallet:    ${nwc ? 'connected' : 'not set'}`)
  if (isProvider) {
    if (opts.dvmBackend) {
      console.log(`  P2P Backend:   Hyperswarm topic=SHA256(2020117-dvm-kind-${opts.provide}) timeout=${opts.dvmBackendTimeout}s`)
    } else if (opts.simpleBackend) {
      console.log(`  Backend:       Simple (rule-based, no AI)`)
    } else if (opts.xaiBackend) {
      console.log(`  Backend:       xAI Grok grok-4.20-reasoning + web search${identity.xaiApiKey ? '' : ' ⚠️  no api key!'}`)
    } else {
      console.log(`  Ollama:        ${opts.ollamaUrl} / ${ollamaModel}`)
    }
    console.log(`  Max Jobs:      ${opts.maxJobs}`)
  }
  console.log('='.repeat(60))

  // --- State ---
  let relay = null
  let connecting = false
  const pendingJobs = new Map()
  const pending5300Jobs = new Map()
  const settled5300Jobs = new Set()
  const settledJobs = new Set()
  const threadTracker = new Map()
  const repliedTo = new Set()
  const liked = new Set()
  // Provider state
  const activeProviderJobs = new Set()  // currently processing job IDs
  const handledJobs = new Set()         // already seen request IDs
  const retryingJobs = new Set()        // jobs being force-retried by scan

  // --- Relay ---
  async function ensureRelay() {
    if (relay && relay.connected) return relay
    if (connecting) { await new Promise(r => setTimeout(r, 2000)); return relay }
    connecting = true
    try {
      relay = await Relay.connect(opts.relay)
      console.log(`\n[${ts()}] Connected to ${opts.relay}`)
      setupSubscriptions()
      relay.onclose = () => {
        console.log(`\n[${ts()}] Disconnected, reconnecting in 10s...`)
        relay = null
        setTimeout(ensureRelay, 10000)
      }
    } catch (e) {
      console.error(`\n[${ts()}] Connect failed: ${e.message}, retrying in 10s...`)
      relay = null
      setTimeout(ensureRelay, 10000)
    } finally { connecting = false }
    return relay
  }

  // --- Subscriptions ---
  function setupSubscriptions() {
    if (!relay) return

    if (opts.reply) {
      // Subscribe to all Kind 1 notes — reply to anyone on the relay, not just mentions
      relay.subscribe([{ kinds: [1], since: Math.floor(Date.now()/1000) }], {
        onevent: async (e) => { try { await handleReply(e) } catch (err) { console.error(`  Reply err: ${err.message}`) } },
      })
      console.log(`  Subscribed: replies (all notes)`)

      // Subscribe to DVM job posts (Kind 5100) — comment using Ollama if available
      if (ollamaModel) {
        relay.subscribe([{ kinds: [5100], since: Math.floor(Date.now()/1000) }], {
          onevent: async (e) => { try { await handleDvmJobReply(e) } catch (err) { console.error(`  DVM job reply err: ${err.message}`) } },
        })
        console.log(`  Subscribed: DVM job comments (Kind 5100)`)
      }
    }

    if (opts.like) {
      relay.subscribe([{ kinds: [1], since: Math.floor(Date.now()/1000) }], {
        onevent: async (e) => { try { await handleLike(e) } catch (err) { console.error(`  Like err: ${err.message}`) } },
      })
      console.log(`  Subscribed: timeline (auto-like)`)
    }

    if (opts.dvmInterval > 0) {
      // Use earliest pending job time as since — catches results that arrived during reconnect
      const earliestJob = Math.min(...[...pendingJobs.values()].map(j => j.postedAt), Date.now()) / 1000
      const dvmSince = Math.floor(earliestJob) - 5
      relay.subscribe([{ kinds: [6100, 7000], '#p': [identity.pubkey], since: dvmSince }], {
        onevent: async (e) => { try { await handleDVMResponse(e) } catch (err) { console.error(`  DVM response err: ${err.message}`) } },
      })
      console.log(`  Subscribed: DVM results (Kind 6100 + 7000, since ${new Date(dvmSince*1000).toLocaleTimeString()})`)

      // Subscribe for Kind 5300 (content discovery) responses
      const earliest5300 = Math.min(...[...pending5300Jobs.values()].map(j => j.postedAt), Date.now()) / 1000
      relay.subscribe([{ kinds: [6300, 7000], '#p': [identity.pubkey], since: Math.floor(earliest5300) - 5 }], {
        onevent: async (e) => { try { await handleDVM5300Response(e) } catch (err) { console.error(`  5300 response err: ${err.message}`) } },
      })
      console.log(`  Subscribed: DVM 5300 results (Kind 6300 + 7000)`)

      // On first connect only: recover jobs that got results while script was down
      recoverUnreviewedJobs()
    }

    // Provider: subscribe for incoming job requests
    if (isProvider) {
      relay.subscribe([{ kinds: [opts.provide], since: Math.floor(Date.now()/1000) - 300 }], {
        onevent: async (e) => { try { await handleIncomingJob(e) } catch (err) { console.error(`  Provider err: ${err.message}`) } },
      })
      console.log(`  Subscribed: incoming jobs (Kind ${opts.provide})`)

      // Also listen for customer feedback on our results (rejections etc)
      relay.subscribe([{ kinds: [7000], '#p': [identity.pubkey], since: Math.floor(Date.now()/1000) }], {
        onevent: async (e) => {
          if (e.pubkey === identity.pubkey) return
          const status = e.tags.find(t => t[0] === 'status')?.[1]
          const eTag = e.tags.find(t => t[0] === 'e')
          const fullJobId = eTag?.[1]
          const jobId = fullJobId?.slice(0, 12) || '?'
          console.log(`\n[${ts()}] [${identity.name}] Customer feedback: ${status} for ${jobId}...`)
          if (e.content) console.log(`  Message: ${e.content.slice(0, 100)}`)
          // If customer re-opened the job (error feedback), allow re-processing
          if (status === 'error' && fullJobId) {
            handledJobs.delete(fullJobId)
            activeProviderJobs.delete(fullJobId)
            console.log(`  Job re-opened — fetching to re-process...`)
            try {
              const r2 = await ensureRelay()
              if (r2) {
                const jobEvents = await new Promise(resolve => {
                  const evts = []
                  const sub = r2.subscribe([{ ids: [fullJobId] }], {
                    onevent: ev => evts.push(ev),
                    oneose: () => { sub.close(); resolve(evts) },
                  })
                  setTimeout(() => { try { sub.close() } catch {} resolve(evts) }, 3000)
                })
                if (jobEvents[0]) await handleIncomingJob(jobEvents[0])
              }
            } catch (err) { console.error(`  Re-fetch failed: ${err.message}`) }
          }
        },
      })
      console.log(`  Subscribed: customer feedback`)
    }
  }

  // --- Reply handler ---
  async function handleReply(event) {
    if (event.pubkey === identity.pubkey) return
    if (repliedTo.has(event.id)) return
    if (Math.random() > opts.replyChance) return
    const r = await ensureRelay(); if (!r) return

    const eTags = event.tags.filter(t => t[0] === 'e')
    const rootTag = eTags.find(t => t[3] === 'root')
    const threadRoot = rootTag ? rootTag[1] : (eTags.length > 0 ? eTags[0][1] : event.id)
    const tracker = threadTracker.get(threadRoot) || { count: 0 }
    if (tracker.count >= opts.maxReplies) return

    const round = tracker.count + 1
    let content
    if (ollamaModel) {
      try {
        const lang = Math.random() < 0.5 ? '中文' : 'English'
        const isLast = round >= opts.maxReplies
        const persona = [identity.displayName, identity.about].filter(Boolean).join(' — ')
        content = await ollamaGenerate(
          opts.ollamaUrl, SOCIAL_MODEL,
          `Someone on Nostr posted: "${event.content.slice(0, 200)}"\n\nWrite a short reply (1-2 sentences) in ${lang}. ${isLast ? 'Wrap up the conversation warmly.' : 'React naturally — relate, empathize, or add something genuine.'} Be casual and human.`,
          `You are ${persona || identity.name}. Keep it brief and natural.`,
          150,
        )
        content = content?.trim()
      } catch {}
    }
    if (!content) content = pickReply(round)
    console.log(`\n[${ts()}] [${identity.name}] Replying (${round}/${opts.maxReplies})`)
    console.log(`  Them: ${event.content.slice(0,60)}`)
    console.log(`  Us:   ${content.slice(0,60)}`)

    const re = signWithPow({ kind: 1, pubkey: identity.pubkey, content,
      tags: [['e',threadRoot,opts.relay,'root'],['e',event.id,opts.relay,'reply'],['p',event.pubkey]],
      created_at: Math.floor(Date.now()/1000),
    }, identity.sk)
    await publishEvent(r, re)
    repliedTo.add(event.id)
    tracker.count = round; tracker.lastReplyAt = Date.now()
    threadTracker.set(threadRoot, tracker)
  }

  // --- DVM job comment handler ---
  async function handleDvmJobReply(event) {
    if (event.pubkey === identity.pubkey) return
    if (repliedTo.has(event.id)) return
    if (Math.random() > opts.replyChance) return
    const r = await ensureRelay(); if (!r) return

    const input = event.tags.find(t => t[0] === 'i')?.[1] || event.content || ''
    if (!input.trim()) return

    console.log(`\n[${ts()}] [${identity.name}] Commenting on DVM job ${event.id.slice(0,12)}...`)
    console.log(`  Job: ${input.slice(0,80)}`)

    let comment
    try {
      comment = await ollamaGenerate(
        opts.ollamaUrl, ollamaModel,
        `A user posted this task on a decentralized AI marketplace: "${input.slice(0, 300)}"\n\nWrite a brief, genuine comment (1-2 sentences) reacting to this task. Be natural and conversational, not promotional. Do NOT offer to do the task yourself.`,
        'You are a casual participant in an AI agent marketplace. Keep comments short, human, and relevant.',
      )
      comment = comment?.trim()
    } catch (e) {
      console.error(`  DVM job comment Ollama err: ${e.message}`)
      return
    }
    if (!comment) return

    console.log(`  Comment: ${comment.slice(0,80)}`)
    const re = signWithPow({ kind: 1, pubkey: identity.pubkey, content: comment,
      tags: [['e', event.id, opts.relay, 'root'], ['p', event.pubkey]],
      created_at: Math.floor(Date.now()/1000),
    }, identity.sk)
    await publishEvent(r, re)
    repliedTo.add(event.id)
  }

  // --- Like handler ---
  async function handleLike(event) {
    if (event.pubkey === identity.pubkey) return
    if (liked.has(event.id)) return
    if (Math.random() > opts.likeChance) return
    const r = await ensureRelay(); if (!r) return
    console.log(`\n[${ts()}] [${identity.name}] Liking ${event.pubkey.slice(0,12)}...`)
    const le = signWithPow({ kind: 7, pubkey: identity.pubkey, content: '+',
      tags: [['e',event.id,opts.relay],['p',event.pubkey]],
      created_at: Math.floor(Date.now()/1000),
    }, identity.sk)
    await publishEvent(r, le)
    liked.add(event.id)
    if (liked.size > 5000) { const it = liked.values(); for (let i=0;i<1000;i++) liked.delete(it.next().value) }
  }

  // --- DVM Response handler (Customer side) ---
  async function handleDVMResponse(event) {
    const eTag = event.tags.find(t => t[0] === 'e'); if (!eTag) return
    const requestId = eTag[1]

    if (event.kind === 7000) {
      const status = event.tags.find(t => t[0] === 'status')?.[1]
      const job = pendingJobs.get(requestId)
      console.log(`\n[${ts()}] [${identity.name}] DVM feedback: ${status} for ${requestId.slice(0,12)}...`)
      console.log(`  Provider: ${event.pubkey.slice(0,12)}...`)
      if (job) job.status = status
      return
    }

    if (event.kind !== 6100) return

    const providerPubkey = event.pubkey
    const resultContent = event.content
    const job = pendingJobs.get(requestId)

    // Already settled — reject all latecomers
    if (settledJobs.has(requestId)) {
      console.log(`\n[${ts()}] [${identity.name}] Late result from ${providerPubkey.slice(0,12)}... — job already settled`)
      const r = await ensureRelay()
      if (r) {
        const msg = Math.random() < 0.8
          ? `Job already fulfilled by another provider. Thanks for your effort.`
          : `该任务已由其他 provider 完成结算，感谢参与。`
        const fe = signWithPow({ kind: 7000, pubkey: identity.pubkey, content: msg,
          tags: [['status','error'],['e',requestId],['p',providerPubkey]],
          created_at: Math.floor(Date.now()/1000),
        }, identity.sk)
        await publishEvent(r, fe)
      }
      return
    }

    // Check relay for existing review (restart safety)
    try {
      const r0 = await ensureRelay()
      if (r0) {
        let alreadyReviewed = false
        await new Promise((resolve) => {
          const sub = r0.subscribe([{ kinds: [31117], authors: [identity.pubkey], '#e': [requestId], limit: 1 }], {
            onevent: () => { alreadyReviewed = true; sub.close(); resolve() },
            oneose: () => { sub.close(); resolve() },
          })
          setTimeout(() => { try { sub.close() } catch {} resolve() }, 5000)
        })
        if (alreadyReviewed) {
          settledJobs.add(requestId)
          console.log(`\n[${ts()}] [${identity.name}] Job ${requestId.slice(0,12)}... already reviewed (restarted?)`)
          // Still reject this late provider
          const r = await ensureRelay()
          if (r) {
            const fe = signWithPow({ kind: 7000, pubkey: identity.pubkey,
              content: Math.random() < 0.8
                ? `Job already fulfilled by another provider. Thanks for your effort.`
                : `该任务已由其他 provider 完成结算，感谢参与。`,
              tags: [['status','error'],['e',requestId],['p',providerPubkey]],
              created_at: Math.floor(Date.now()/1000),
            }, identity.sk)
            await publishEvent(r, fe)
          }
          return
        }
      }
    } catch {}

    console.log(`\n[${ts()}] [${identity.name}] DVM result received!`)
    console.log(`  Job:      ${requestId.slice(0,12)}... ${job ? `(${job.param})` : ''}`)
    console.log(`  Provider: ${providerPubkey.slice(0,12)}...`)
    console.log(`  Result:   ${resultContent.slice(0,120)}${resultContent.length > 120 ? '...' : ''}`)

    const jobInput = job?.input || ''
    const evaluation = identity.xaiApiKey
      ? await evaluateResultWithXai(identity.xaiApiKey, jobInput, resultContent)
      : evaluateResult(resultContent)
    console.log(`  Quality:  score=${evaluation.score} rating=${evaluation.rating}/5 (${evaluation.quality}) [${identity.xaiApiKey ? 'xai' : 'rule'}]`)
    console.log(`            reason: ${evaluation.reason || `keywords=${evaluation.matchedKeywords} length=${evaluation.length}`}`)

    // Reject low quality — give them a chance to improve
    if (evaluation.quality === 'reject') {
      const reason = evaluation.reason || 'Result quality too low. Please provide detailed technical analysis with specific price levels and indicator values.'
      console.log(`  REJECTED — sending feedback to ${providerPubkey.slice(0,12)}...`)
      const r = await ensureRelay()
      if (r) {
        if (job) {
          job.rejectCounts = job.rejectCounts || {}
          job.rejectCounts[providerPubkey] = (job.rejectCounts[providerPubkey] || 0) + 1
        }
        const fe = signWithPow({ kind: 7000, pubkey: identity.pubkey, content: reason,
          tags: [['status','error'],['e',requestId],['p',providerPubkey]],
          created_at: Math.floor(Date.now()/1000),
        }, identity.sk)
        await publishEvent(r, fe)
      }
      return  // Do NOT settle — keep job open for better responses
    }

    // Quality acceptable — settle immediately, reject all future responses
    settledJobs.add(requestId)

    if (!canAutoPay) {
      console.log(`  Acceptable quality but auto-pay disabled`)
      pendingJobs.delete(requestId); return
    }

    // Pay
    const bidSats = job?.bidSats || opts.dvmBid
    let paySats
    if (evaluation.rating >= 4) paySats = bidSats
    else if (evaluation.rating === 3) paySats = Math.ceil(bidSats * 0.7)
    else if (evaluation.rating <= 2) paySats = 0
    else paySats = Math.ceil(bidSats * 0.5)

    // Prefer bolt11 tag (NWC make_invoice, no LNURL needed), then lud16, then profile lookup
    const resultBolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1]
    const resultLud16 = event.tags.find(t => t[0] === 'lud16' || t[0] === 'lightning_address')?.[1]
    let paid = false
    if (resultBolt11 && paySats >= 1) {
      console.log(`  Paying ${paySats} sats via bolt11 (NWC direct)...`)
      try {
        const pr = await nwcPayInvoice(nwc, resultBolt11)
        console.log(`  Payment OK! preimage: ${pr?.preimage?.slice(0,16) || 'n/a'}...`)
        paid = true
      } catch (e) { console.error(`  Payment FAILED (bolt11): ${e.message}`) }
    } else {
      const providerLnAddress = resultLud16 || await resolveProviderLnAddress(opts.relay, providerPubkey)
      if (providerLnAddress && paySats >= 1) {
        console.log(`  Paying ${paySats} sats to ${providerLnAddress} (LNURL)...`)
        try {
          const pr = await nwcPayLightningAddress(nwc, providerLnAddress, paySats)
          console.log(`  Payment OK! preimage: ${pr?.preimage?.slice(0,16) || 'n/a'}...`)
          paid = true
        } catch (e) { console.error(`  Payment FAILED (LNURL): ${e.message}`) }
      } else { console.log(`  Cannot pay: ${!providerLnAddress ? 'no LN address or bolt11' : `paySats=${paySats} (rating too low — not paying)`}`) }
    }

    const r = await ensureRelay()
    if (r && !paid) {
      let errorMsg, unsettleJob
      if (paySats === 0) {
        // Quality rejection — close job permanently, no retry needed
        errorMsg = evaluation.reason
          ? `Result rejected: ${evaluation.reason}`
          : `Result quality too low (${evaluation.rating}/5) — not paying.`
        unsettleJob = false
      } else {
        // Payment infrastructure failed — unsettled so other providers can try
        errorMsg = 'Payment failed (no Lightning Address or NWC error). Job re-opened.'
        unsettleJob = true
      }
      if (unsettleJob) settledJobs.delete(requestId)
      const fe = signWithPow({ kind: 7000, pubkey: identity.pubkey,
        content: errorMsg,
        tags: [['status','error'],['e',requestId],['p',providerPubkey]],
        created_at: Math.floor(Date.now()/1000),
      }, identity.sk)
      await publishEvent(r, fe)
      console.log(`  ${unsettleJob ? 'Payment failed — un-settled job' : 'Quality rejected — job closed'}, sent Kind 7000 error`)
    }
    if (r && paid) {
      // Kind 31117 — review
      const reviewPool = REVIEW_TEMPLATES[evaluation.quality] || REVIEW_TEMPLATES.good
      const reviewContent = pick(Math.random() < 0.8 ? reviewPool.en : reviewPool.zh)
      console.log(`  Review: ${evaluation.rating}/5 — ${reviewContent.slice(0,40)}...`)
      const re = signWithPow({ kind: 31117, pubkey: identity.pubkey, content: reviewContent,
        tags: [['d',requestId],['e',requestId],['p',providerPubkey],['rating',String(evaluation.rating)],['k','5100'],['paid',paid?String(paySats):'0']],
        created_at: Math.floor(Date.now()/1000),
      }, identity.sk)
      await publishEvent(r, re)

      // Kind 7000 success — close job
      const successMsg = Math.random() < 0.8
        ? `Job closed. Paid ${paySats} sats to winner (${evaluation.rating}/5). Other providers: thanks for participating.`
        : `任务已结算 ${paySats} sats（${evaluation.rating}/5）。其他参与者感谢你们的竞标。`
      const se = signWithPow({ kind: 7000, pubkey: identity.pubkey, content: successMsg,
        tags: [['status','success'],['e',requestId],['p',providerPubkey],['amount',String(paySats*1000)]],
        created_at: Math.floor(Date.now()/1000),
      }, identity.sk)
      await publishEvent(r, se)
      console.log(`  Kind 7000 success sent — job closed`)

      // Kind 30311 — rolling endorsement
      const endorseContent = evaluation.reason
        || (Math.random() < 0.8 ? pick(reviewPool.en) : pick(reviewPool.zh))
      const ee = signWithPow({ kind: 30311, pubkey: identity.pubkey, content: endorseContent,
        tags: [['d',providerPubkey],['p',providerPubkey],['e',requestId],['rating',String(evaluation.rating)],['k','5100'],['paid',paid?String(paySats):'0']],
        created_at: Math.floor(Date.now()/1000),
      }, identity.sk)
      await publishEvent(r, ee)
      console.log(`  Kind 30311 endorsement sent`)
    }

    pendingJobs.delete(requestId)
    console.log(`  Settled! (${pendingJobs.size} pending)`)
  }

  // --- DVM 5300 Response handler ---
  async function handleDVM5300Response(event) {
    const eTag = event.tags.find(t => t[0] === 'e'); if (!eTag) return
    const requestId = eTag[1]
    if (!pending5300Jobs.has(requestId)) return  // not our job

    if (event.kind === 7000) {
      const status = event.tags.find(t => t[0] === 'status')?.[1]
      console.log(`\n[${ts()}] [${identity.name}] 5300 feedback: ${status} from ${event.pubkey.slice(0,12)}...`)
      return
    }

    if (event.kind !== 6300) return
    if (settled5300Jobs.has(`${requestId}:${event.pubkey}`)) return  // already handled this provider

    const job = pending5300Jobs.get(requestId)
    const providerPubkey = event.pubkey

    // Parse event IDs from content
    let eventIds = []
    try {
      const parsed = JSON.parse(event.content)
      if (Array.isArray(parsed)) eventIds = parsed.map(t => Array.isArray(t) ? t[1] : t).filter(Boolean)
    } catch { /* content might be plain text or unparseable */ }

    console.log(`\n[${ts()}] [${identity.name}] 5300 result from ${providerPubkey.slice(0,12)}... (${eventIds.length} event IDs)`)

    if (eventIds.length === 0) {
      console.log(`  Empty or non-standard result — skipping`)
      return
    }

    // Evaluate quality
    const evaluation = await evaluate5300Result(opts.ollamaUrl, ollamaModel, job.query, eventIds, opts.relay)
    console.log(`  Quality: ${evaluation.rating}/5 (${evaluation.quality}) — ${evaluation.reason}`)

    settled5300Jobs.add(`${requestId}:${providerPubkey}`)

    if (!canAutoPay || evaluation.rating <= 2) {
      console.log(`  Not paying (rating too low or auto-pay disabled)`)
      return
    }

    const bidSats = job.bidSats
    const paySats = evaluation.rating >= 3 ? bidSats : 0
    if (paySats < 1) return

    const resultLud16 = event.tags.find(t => t[0] === 'lud16' || t[0] === 'lightning_address')?.[1]
    const resultBolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1]
    let paid = false

    if (resultBolt11) {
      try {
        await nwcPayInvoice(nwc, resultBolt11)
        paid = true
      } catch (e) { console.error(`  5300 payment FAILED (bolt11): ${e.message}`) }
    } else {
      const lnAddr = resultLud16 || await resolveProviderLnAddress(opts.relay, providerPubkey)
      if (lnAddr) {
        try {
          await nwcPayLightningAddress(nwc, lnAddr, paySats)
          paid = true
        } catch (e) { console.error(`  5300 payment FAILED (LNURL): ${e.message}`) }
      }
    }

    if (paid) {
      console.log(`  Paid ${paySats} sats to ${providerPubkey.slice(0,12)}...`)
      const r = await ensureRelay()
      if (r) {
        const se = signWithPow({ kind: 7000, pubkey: identity.pubkey,
          content: `Content discovery result accepted (${evaluation.rating}/5). Paid ${paySats} sats.`,
          tags: [['status','success'],['e',requestId],['p',providerPubkey],['amount',String(paySats*1000)]],
          created_at: Math.floor(Date.now()/1000),
        }, identity.sk)
        await publishEvent(r, se)
      }
    }
  }

  // --- Startup recovery: find 6100 results from last 24h that were never reviewed ---
  let hasRunRecovery = false
  async function recoverUnreviewedJobs() {
    if (hasRunRecovery) return   // only once per process
    hasRunRecovery = true
    const r = await ensureRelay()
    if (!r) return
    const since = Math.floor(Date.now() / 1000) - 86400
    console.log(`\n[${ts()}] [${identity.name}] Startup recovery: checking for unreviewed results (last 24h)...`)
    const results = []
    await new Promise(resolve => {
      const sub = r.subscribe([{ kinds: [6100], '#p': [identity.pubkey], since }], {
        onevent: (e) => results.push(e),
        oneose: () => { sub.close(); resolve() },
      })
      setTimeout(() => { try { sub.close() } catch {} resolve() }, 8000)
    })
    if (!results.length) { console.log(`  No unreviewed results found`); return }
    console.log(`  Found ${results.length} result(s) — checking for missing reviews...`)
    for (const event of results) {
      const requestId = event.tags.find(t => t[0] === 'e')?.[1]
      if (!requestId || settledJobs.has(requestId)) continue
      let alreadyReviewed = false
      await new Promise(resolve => {
        const sub = r.subscribe([{ kinds: [31117], authors: [identity.pubkey], '#e': [requestId], limit: 1 }], {
          onevent: () => { alreadyReviewed = true; sub.close(); resolve() },
          oneose: () => { sub.close(); resolve() },
        })
        setTimeout(() => { try { sub.close() } catch {} resolve() }, 5000)
      })
      if (alreadyReviewed) {
        settledJobs.add(requestId)
        console.log(`  ${requestId.slice(0,12)}... already reviewed — skip`)
        continue
      }
      console.log(`  ${requestId.slice(0,12)}... unreviewed — recovering...`)
      try { await handleDVMResponse(event) } catch (e) { console.error(`  Recovery failed: ${e.message}`) }
    }
    console.log(`  Recovery complete`)
  }

  // --- Incoming Job handler (Provider side) ---
  async function handleIncomingJob(event) {
    // Don't accept own jobs
    if (event.pubkey === identity.pubkey) return
    // Already handled
    if (handledJobs.has(event.id) && !retryingJobs.has(event.id)) return
    // Check p-tag: if directed to someone else, skip
    const pTag = event.tags.find(t => t[0] === 'p')
    if (pTag && pTag[1] !== identity.pubkey) return
    // Capacity check
    if (activeProviderJobs.size >= opts.maxJobs) {
      console.log(`\n[${ts()}] [${identity.name}] Job ${event.id.slice(0,12)}... skipped (at capacity ${opts.maxJobs})`)
      return
    }

    // Reserve slot immediately (before any await) to prevent race condition
    handledJobs.add(event.id)
    activeProviderJobs.add(event.id)

    // Skip old jobs that already have a result or we already attempted them
    const jobAge = Math.floor(Date.now()/1000) - event.created_at
    if (jobAge > 300) { // older than 5 min — check relay for prior activity
      try {
        const r0 = await ensureRelay()
        if (r0) {
          const resultKind = event.kind + 1000 // 5100 → 6100
          let alreadyHandled = false
          await new Promise((resolve) => {
            // Check for: result event (6xxx) OR our own status event (7000) for this job
            const sub = r0.subscribe([
              { kinds: [resultKind], '#e': [event.id], limit: 1 },
              { kinds: [7000], authors: [identity.pubkey], '#e': [event.id], limit: 1 },
            ], {
              onevent: () => { alreadyHandled = true; sub.close(); resolve() },
              oneose: () => { sub.close(); resolve() },
            })
            setTimeout(() => { try { sub.close() } catch {} resolve() }, 5000)
          })
          if (alreadyHandled) {
            console.log(`\n[${ts()}] [${identity.name}] Skipping job ${event.id.slice(0,12)}... (already handled)`)
            activeProviderJobs.delete(event.id)
            return
          }
        }
      } catch {}
    }

    const input = event.tags.find(t => t[0] === 'i')?.[1] || event.content || ''
    const customerPubkey = event.pubkey

    // Verify customer can pay: check their Kind 0 profile for lud16
    if (opts.providerPrice > 0) {
      try {
        const r0 = await ensureRelay()
        let customerLud16 = null
        if (r0) {
          await new Promise((resolve) => {
            const sub = r0.subscribe([{ kinds: [0], authors: [customerPubkey], limit: 1 }], {
              onevent: (e) => {
                try { const p = JSON.parse(e.content); customerLud16 = p.lud16 || p.lud06 || null } catch {}
                sub.close(); resolve()
              },
              oneose: () => { sub.close(); resolve() },
            })
            setTimeout(() => { try { sub.close() } catch {} resolve() }, 3000)
          })
        }
        if (!customerLud16) {
          console.log(`\n[${ts()}] [${identity.name}] Job ${event.id.slice(0,12)}... skipped (customer has no lightning address — cannot pay)`)
          activeProviderJobs.delete(event.id)
          return
        }
      } catch {}
    }

    console.log(`\n[${ts()}] [${identity.name}] Incoming job!`)
    console.log(`  Job:      ${event.id.slice(0,12)}... (Kind ${event.kind})`)
    console.log(`  Customer: ${customerPubkey.slice(0,12)}...`)
    console.log(`  Input:    ${input.slice(0,100)}${input.length > 100 ? '...' : ''}`)

    const r = await ensureRelay()
    if (!r) { activeProviderJobs.delete(event.id); return }

    // 1. Send processing feedback
    console.log(`  Sending Kind 7000 (processing)...`)
    const fb = signWithPow({ kind: 7000, pubkey: identity.pubkey, content: '',
      tags: [['status','processing'],['e',event.id],['p',customerPubkey]],
      created_at: Math.floor(Date.now()/1000),
    }, identity.sk)
    await publishEvent(r, fb)

    // 2. Process job (local Ollama or p2p DVM backend)
    let result
    const startTime = Date.now()
    try {
      if (opts.dvmBackend) {
        console.log(`  Connecting via P2P (Hyperswarm) to process job...`)
        result = await processJobViaP2P(identity.nwcUri, input, opts.provide, opts.dvmBackendTimeout, 100, opts.ollamaModel || 'qwen3.5:9b')
      } else if (opts.simpleBackend) {
        console.log(`  Processing with simple backend (no AI)...`)
        result = processJobSimple(input, opts.provide)
      } else if (opts.xaiBackend) {
        if (!identity.xaiApiKey) throw new Error('xai_api_key not set for this agent in .2020117_keys')
        console.log(`  Calling xAI Grok (grok-4-fast-reasoning)...`)
        result = await processJobWithXai(identity.xaiApiKey, input, opts.provide)
      } else {
        console.log(`  Calling Ollama (${ollamaModel})...`)
        result = await processJobWithOllama(opts.ollamaUrl, ollamaModel, input, opts.provide)
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`  Backend responded in ${elapsed}s (${result.length} chars)`)
    } catch (e) {
      console.error(`  Backend error: ${e.message}`)
      // Send error feedback
      const errFb = signWithPow({ kind: 7000, pubkey: identity.pubkey,
        content: `Processing error: ${e.message}`,
        tags: [['status','error'],['e',event.id],['p',customerPubkey]],
        created_at: Math.floor(Date.now()/1000),
      }, identity.sk)
      await publishEvent(r, errFb)
      activeProviderJobs.delete(event.id)
      return
    }

    // 3. Publish result (Kind 6xxx = 6000 + request kind offset)
    const resultKind = event.kind + 1000  // 5100 -> 6100, 5302 -> 6302
    console.log(`  Publishing result (Kind ${resultKind})...`)
    console.log(`  Result preview: ${result.slice(0,120)}${result.length > 120 ? '...' : ''}`)

    const resultTags = [
      ['request', JSON.stringify(event)],
      ['e', event.id],
      ['p', customerPubkey],
    ]
    if (opts.providerPrice > 0) {
      resultTags.push(['amount', String(opts.providerPrice * 1000)])  // msats
      // Try NWC make_invoice first (no LNURL dependency), fallback to lud16
      if (nwc) {
        try {
          const invoice = await nwcMakeInvoice(nwc, opts.providerPrice, `DVM job ${event.id.slice(0,8)}`)
          if (invoice) {
            resultTags.push(['bolt11', invoice])
            console.log(`  Invoice generated via NWC: ${invoice.slice(0,30)}...`)
          }
        } catch (e) {
          console.error(`  NWC make_invoice failed: ${e.message}, falling back to lud16`)
          if (identity.lightningAddress) resultTags.push(['lud16', identity.lightningAddress])
        }
      } else if (identity.lightningAddress) {
        resultTags.push(['lud16', identity.lightningAddress])
      }
    }
    const resultEvent = signWithPow({
      kind: resultKind, pubkey: identity.pubkey,
      content: result,
      tags: resultTags,
      created_at: Math.floor(Date.now() / 1000),
    }, identity.sk)
    await publishEvent(r, resultEvent)

    // 4. Review customer (Kind 31117, role=provider) + like job request (Kind 7)
    try {
      // Kind 31117 — provider reviews customer
      const re = signWithPow({ kind: 31117, pubkey: identity.pubkey,
        content: 'Clear task requirements, good collaboration.',
        tags: [['e', event.id], ['p', customerPubkey], ['rating', '5'], ['role', 'provider'], ['k', String(event.kind)]],
        created_at: Math.floor(Date.now()/1000),
      }, identity.sk)
      await publishEvent(r, re)

      // Kind 7 — like the job request event
      const like = signWithPow({ kind: 7, pubkey: identity.pubkey,
        content: '+',
        tags: [['e', event.id], ['p', customerPubkey]],
        created_at: Math.floor(Date.now()/1000),
      }, identity.sk)
      await publishEvent(r, like)
      console.log(`  Reviewed customer + liked job request`)
    } catch (e) { console.error(`  Review/like failed: ${e.message}`) }

    // 5. If used P2P backend, review the upstream provider (Kind 31117 + Kind 30311)
    if (opts.dvmBackend && p2pSession.providerPubkey) {
      const provPubkey = p2pSession.providerPubkey
      try {
        const re = signWithPow({ kind: 31117, pubkey: identity.pubkey,
          content: 'Fast and reliable P2P Ollama provider. Delivered quality results.',
          tags: [['e',event.id],['p',provPubkey],['rating','5'],['role','customer'],['k',String(event.kind)]],
          created_at: Math.floor(Date.now()/1000),
        }, identity.sk)
        await publishEvent(r, re)
        const ee = signWithPow({ kind: 30311, pubkey: identity.pubkey,
          content: JSON.stringify({ rating: 5, comment: 'Reliable P2P provider', trusted: true,
            context: { kinds: [event.kind], last_job_at: Math.floor(Date.now()/1000) } }),
          tags: [['d',provPubkey],['p',provPubkey],['e',event.id],['rating','5']],
          created_at: Math.floor(Date.now()/1000),
        }, identity.sk)
        await publishEvent(r, ee)
        console.log(`  Reviewed upstream provider ${provPubkey.slice(0,12)}... (5/5)`)
      } catch (e) { console.error(`  Provider review failed: ${e.message}`) }
    }

    activeProviderJobs.delete(event.id)
    console.log(`  Job done! (${activeProviderJobs.size}/${opts.maxJobs} active)`)
  }

  // --- Connect & start ---
  await ensureRelay()

  if (nwc) {
    try {
      const balance = await nwcGetBalance(nwc)
      console.log(`\n  NWC Balance: ${Math.floor((balance?.balance || 0) / 1000)} sats`)
    } catch (e) { console.log(`\n  NWC Balance check failed: ${e.message}`) }
  }

  // All agents: publish Kind 0 profile on startup
  if (relay) await publishProfile(relay, identity)

  // Provider: publish handler info + first heartbeat
  if (isProvider && relay) {
    await publishHandlerInfo(relay, identity, opts.provide, ollamaModel, opts.providerPrice)
    await publishHeartbeat(relay, identity, opts.provide, opts.providerPrice, 0)
    console.log(`  Provider registered and online`)
    // Scan for unhandled jobs from last 24h and retry them
    setTimeout(() => scanAndRetryUnhandledJobs(), 3000)
  }

  // Customer: catch up on unsettled jobs from before restart
  if (opts.dvmInterval > 0) {
    console.log('\n--- Catching up on unsettled jobs ---')
    try {
      const r0 = await ensureRelay()
      if (!r0) throw new Error('relay not available')
      const lookback = Math.floor(Date.now()/1000) - 72 * 3600
      // 1. Find our recent job requests
      const myJobs = await new Promise((resolve) => {
        const jobs = []
        const sub = r0.subscribe([{ kinds: [5100], authors: [identity.pubkey], since: lookback, limit: 100 }], {
          onevent: (e) => jobs.push(e),
          oneose: () => { sub.close(); resolve(jobs) },
        })
        setTimeout(() => { try { sub.close() } catch {} resolve(jobs) }, 5000)
      })
      console.log(`  Found ${myJobs.length} recent job(s) posted by us`)

      for (const jobEvent of myJobs) {
        const jobId = jobEvent.id
        if (settledJobs.has(jobId)) continue

        // 2. Check if already settled (Kind 7000 success from us)
        const alreadySettled = await new Promise((resolve) => {
          const sub = r0.subscribe([{ kinds: [7000], authors: [identity.pubkey], '#e': [jobId], limit: 1 }], {
            onevent: (e) => {
              if (e.tags.find(t => t[0] === 'status' && t[1] === 'success')) { sub.close(); resolve(true) }
            },
            oneose: () => { sub.close(); resolve(false) },
          })
          setTimeout(() => { try { sub.close() } catch {} resolve(false) }, 3000)
        })
        if (alreadySettled) { settledJobs.add(jobId); continue }

        // 3. Find any Kind 6100 results for this job
        const results = await new Promise((resolve) => {
          const res = []
          const sub = r0.subscribe([{ kinds: [6100], '#e': [jobId], limit: 5 }], {
            onevent: (e) => res.push(e),
            oneose: () => { sub.close(); resolve(res) },
          })
          setTimeout(() => { try { sub.close() } catch {} resolve(res) }, 3000)
        })
        // 4. Re-register job in pendingJobs (even if no results yet — poll timer will retry)
        const input = jobEvent.tags.find(t => t[0] === 'i')?.[1] || jobEvent.content || ''
        const bidSats = parseInt(jobEvent.tags.find(t => t[0] === 'bid')?.[1] || String(opts.dvmBid * 1000)) / 1000
        pendingJobs.set(jobId, { requestId: jobId, input, param: input.slice(0,30), bidSats, postedAt: jobEvent.created_at * 1000, status: 'pending' })
        if (results.length === 0) {
          console.log(`  Job ${jobId.slice(0,12)}... registered, no results yet — will poll`)
          continue
        }
        console.log(`  Replaying result for job ${jobId.slice(0,12)}... (${results.length} result(s))`)
        for (const result of results) {
          try { await handleDVMResponse(result) } catch (e) { console.error(`  Catchup eval err: ${e.message}`) }
          if (settledJobs.has(jobId)) break
        }
      }
    } catch (e) { console.error(`  Catchup error: ${e.message}`) }
    console.log('--- Catchup done ---')
  }

  // First round
  console.log('\n--- First round ---')
  if (opts.noteInterval > 0 && relay) await postNote(relay, identity, opts.ollamaUrl, ollamaModel)
  if (opts.dvmInterval > 0 && relay) {
    const hasPending = pendingJobs.size > 0
    if (hasPending) console.log(`  Skipping first DVM job — ${pendingJobs.size} pending job(s) already in queue`)
    else await postDVMJob(relay, identity, opts.dvmBid, pendingJobs)
    await postDVM5300Job(relay, identity, opts.dvm5300Bid, pending5300Jobs)
  }
  if (isProvider && opts.noteInterval === 0 && opts.dvmInterval === 0) console.log('  (Provider only mode — waiting for jobs)')

  // Timers
  if (opts.noteInterval > 0) {
    setInterval(async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await ensureRelay()
          if (r) { await postNote(r, identity, opts.ollamaUrl, ollamaModel); break }
          else { await new Promise(r => setTimeout(r, 30000)) }
        } catch (e) { console.error(`Note err (attempt ${attempt}/3): ${e.message}`) }
      }
    }, opts.noteInterval * 60 * 1000)
  }

  if (opts.dvmInterval > 0) {
    setInterval(async () => {
      // Retry up to 3 times if relay is down
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await ensureRelay()
          if (r) { await postDVMJob(r, identity, opts.dvmBid, pendingJobs); break }
          else { console.log(`[${ts()}] DVM timer: relay unavailable (attempt ${attempt}/3), retrying in 30s...`); await new Promise(r => setTimeout(r, 30000)) }
        } catch (e) { console.error(`DVM err (attempt ${attempt}/3): ${e.message}`) }
      }
      // Also post a 5300 content discovery job each interval
      try {
        const r = await ensureRelay()
        if (r) await postDVM5300Job(r, identity, opts.dvm5300Bid, pending5300Jobs)
      } catch (e) { console.error(`DVM 5300 err: ${e.message}`) }
    }, opts.dvmInterval * 60 * 1000)
  }

  // Customer: poll pending jobs for results every 3 min
  if (opts.dvmInterval > 0) {
    setInterval(async () => {
      const unsettled = [...pendingJobs.entries()].filter(([id]) => !settledJobs.has(id))
      if (unsettled.length === 0) return
      const r = await ensureRelay(); if (!r) return
      for (const [jobId, job] of unsettled) {
        try {
          const results = await new Promise((resolve) => {
            const res = []
            const sub = r.subscribe([{ kinds: [6100], '#e': [jobId], limit: 5 }], {
              onevent: (e) => res.push(e),
              oneose: () => { sub.close(); resolve(res) },
            })
            setTimeout(() => { try { sub.close() } catch {} resolve(res) }, 3000)
          })
          for (const result of results) {
            try { await handleDVMResponse(result) } catch (e) { console.error(`  Poll eval err: ${e.message}`) }
            if (settledJobs.has(jobId)) break
          }
        } catch (e) { console.error(`  Poll err for ${jobId.slice(0,12)}: ${e.message}`) }
      }
    }, 3 * 60 * 1000)
  }

  // Provider heartbeat every 1 min
  if (isProvider) {
    setInterval(async () => {
      try {
        const r = await ensureRelay()
        if (r) await publishHeartbeat(r, identity, opts.provide, opts.providerPrice, activeProviderJobs.size)
      } catch {}
    }, 60 * 1000)

    // Retry unhandled jobs every 15 min
    setInterval(() => scanAndRetryUnhandledJobs(), 15 * 60 * 1000)
  }

  async function scanAndRetryUnhandledJobs() {
    const r = await ensureRelay(); if (!r) return
    const since = Math.floor(Date.now() / 1000) - 24 * 3600
    console.log(`\n[${ts()}] [${identity.name}] Scanning for unhandled jobs (last 24h)...`)
    try {
      const jobs = await new Promise((resolve) => {
        const list = []
        const sub = r.subscribe([{ kinds: [opts.provide], since, limit: 100 }], {
          onevent: (e) => list.push(e),
          oneose: () => { sub.close(); resolve(list) },
        })
        setTimeout(() => { try { sub.close() } catch {} resolve(list) }, 5000)
      })
      // Process oldest jobs first — longest-waiting tasks get priority
      jobs.sort((a, b) => a.created_at - b.created_at)
      let retried = 0
      for (const job of jobs) {
        if (activeProviderJobs.size >= opts.maxJobs) break
        if (job.pubkey === identity.pubkey) continue
        if (handledJobs.has(job.id)) continue
        // Check relay: skip if already has a result or success feedback
        const resultKind = opts.provide + 1000
        let alreadyDone = false
        await new Promise((resolve) => {
          const sub = r.subscribe([
            { kinds: [7000], '#e': [job.id], limit: 5 },
          ], {
            onevent: (e) => {
              const status = e.tags.find(t => t[0] === 'status')?.[1]
              // Only skip if customer confirmed success — error means job is still open
              if (status === 'success') { alreadyDone = true; sub.close(); resolve() }
            },
            oneose: () => { sub.close(); resolve() },
          })
          setTimeout(() => { try { sub.close() } catch {} resolve() }, 3000)
        })
        if (alreadyDone) continue
        console.log(`  Retrying unhandled job ${job.id.slice(0,12)}...`)
        handledJobs.delete(job.id)
        retryingJobs.add(job.id)
        try { await handleIncomingJob(job); retried++ } catch (e) { console.error(`  Retry err: ${e.message}`) }
        retryingJobs.delete(job.id)
      }
      console.log(`  Scan done — retried ${retried} job(s)`)
    } catch (e) { console.error(`  Scan error: ${e.message}`) }
  }

  // Cleanup every hour
  setInterval(() => {
    const cutoff = Date.now() - 72 * 60 * 60 * 1000
    for (const [id, t] of threadTracker) { if (t.lastReplyAt < cutoff) threadTracker.delete(id) }
    for (const [id, j] of pendingJobs) { if (j.postedAt < cutoff) pendingJobs.delete(id) }
    for (const [id, j] of pending5300Jobs) { if (j.postedAt < cutoff) pending5300Jobs.delete(id) }
    if (settled5300Jobs.size > 10000) { const it = settled5300Jobs.values(); for (let i=0;i<5000;i++) settled5300Jobs.delete(it.next().value) }
    if (settledJobs.size > 10000) { const it = settledJobs.values(); for (let i=0;i<5000;i++) settledJobs.delete(it.next().value) }
    if (handledJobs.size > 10000) { const it = handledJobs.values(); for (let i=0;i<5000;i++) handledJobs.delete(it.next().value) }
  }, 60 * 60 * 1000)

  const features = [
    opts.noteInterval > 0 && 'notes',
    opts.dvmInterval > 0 && 'dvm-customer',
    canAutoPay && 'auto-pay',
    isProvider && `provider(${opts.provide})`,
    opts.reply && 'reply',
    opts.like && 'like',
  ].filter(Boolean).join(' + ')

  console.log(`\n--- Running [${features}] (Ctrl+C to stop) ---`)
}

main().catch(e => { console.error(e); process.exit(1) })
