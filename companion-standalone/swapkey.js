// swap-key script: double-click swapkey.bat
// 流程：先问要不要换 API 地址（换则写入 config.json + liao.html），
// 再问新 key，替换各文件里的 sk- 密钥，重启 8788，用最终地址验证。
//
// 一次改全四处：DSH(relay provider) / 网页聊天(8788) / Codex(config.toml) / Codex(models.json)
//
// 2026-11 修复：
//  1) 地址那一问也可以直接粘 sk- 密钥（以前会报「地址要以 http:// 开头」直接退出）
//  2) 地址填错不再 exit，而是重问；并拦截 platform.deepseek.com 网页地址
//  3) 切地址时自动把模型名换成该服务商那套（官方 deepseek-flash / 中转 deepseek-v4-flash）
//  4) 补上 config.local.json —— server.js 里它优先级最高，以前从不更新它，
//     所以 key 写进 config.json 也「换不上」
//  5) 同步 Codex：config.toml 的 [model_providers.deepseek] 地址+密钥、models.json 的模型名
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const ROOT = 'C:/Users/lyy44/Documents/deepseek-harness/default-workspace'
const CONFIG = `${ROOT}/companion-standalone/config.json`
const LOCAL_CONFIG = `${ROOT}/companion-standalone/config.local.json`
const SETTINGS = `${ROOT}/companion-offline/settings.json`
const LIAO = `${ROOT}/companion-offline/liao.html`
const TARGETS = [
  'C:/Users/lyy44/.dsh/.credentials.yaml',
  CONFIG,
  LOCAL_CONFIG,
  SETTINGS,
  LIAO,
]
const VBS = `${ROOT}/companion-standalone/start.vbs`
const CREDS = 'C:/Users/lyy44/.dsh/.credentials.yaml'
const DSH_PROFILE = `${process.env.USERPROFILE}/.dsh/profiles/desktop/cordis.patch.yml`
// Codex 的两份配置：config.toml 里 [model_providers.deepseek] 的地址+key，
// models.json 里两个模型的 slug（slug 会被原样当模型名发出去）
const CODEX_CONFIG = `${process.env.USERPROFILE}/.codex/config.toml`
const CODEX_MODELS = `${process.env.USERPROFILE}/.codex/models.json`
const KEY_RE = /sk-[A-Za-z0-9\-_]{20,}/g
const KEY_ONLY_RE = /^sk-[A-Za-z0-9\-_]{20,}$/
// liao.html 里写死的 baseUrl / apiKey 两行，精确匹配替换
const LIAO_BASE_RE = /("baseUrl"\s*:\s*")[^"]*(")/
const LIAO_KEY_RE = /("apiKey"\s*:\s*")[^"]*(")/
const LIAO_BASE_READ_RE = /"baseUrl"\s*:\s*"([^"]*)"/

// 官方接口对应的模型名（中转站那套 deepseek-v4-flash 在官方也叫 deepseek-flash）
const OFFICIAL_MODELS = { chatModel: 'deepseek-v4-pro', extractModel: 'deepseek-flash' }
// 中转站（tmai.ak03.cn 这类）的模型名
const RELAY_MODELS = { chatModel: 'deepseek-v4-pro', extractModel: 'deepseek-v4-flash' }
// Codex 的 models.json 里两个槽位 → 各家模型名
const CODEX_SLUGS = {
  official: { pro: 'deepseek-v4-pro', flash: 'deepseek-flash' },
  relay: { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' },
}

function readJson(f) {
  return JSON.parse(readFileSync(f, 'utf8'))
}
function writeJson(f, obj) {
  writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

// 自己维护输入队列：readline 的 question() 在管道/重定向输入下会丢行
// （数据一次性到达时，第二行还没注册 question 就被当成无主 line 丢掉），
// 用「常驻 line 监听 + 队列」两种场景都能用。
let RL = null
let QUEUE = []
let WAITER = null
function initAsk() {
  if (RL) return
  RL = createInterface({ input: process.stdin, output: process.stdout })
  RL.on('line', (line) => {
    const v = String(line).trim()
    if (WAITER) { const w = WAITER; WAITER = null; w(v) }
    else QUEUE.push(v)
  })
  RL.on('close', () => { if (WAITER) { const w = WAITER; WAITER = null; w('') } })
}
async function ask(q) {
  initAsk()
  process.stdout.write(q)
  if (QUEUE.length) {
    const v = QUEUE.shift()
    process.stdout.write(v + '\n')
    return v
  }
  return new Promise((res) => { WAITER = res })
}
function closeAsk() {
  if (RL) { try { RL.close() } catch {} RL = null }
}

// 把 liao.html 里的 baseUrl / apiKey 换成新值（按行精确替换，不动其他内容）
function replaceLiao(html, { baseUrl, apiKey }) {
  if (baseUrl) html = html.replace(LIAO_BASE_RE, `$1${baseUrl}$2`)
  if (apiKey) html = html.replace(LIAO_KEY_RE, `$1${apiKey}$2`)
  return html
}

// 某个文件当前配的 baseUrl（用来判断 key 是否属于同一个服务商）
function baseUrlOf(f) {
  try {
    if (f.endsWith('settings.json')) return String(readJson(f).baseUrl || '')
    if (f.endsWith('liao.html')) {
      const m = readFileSync(f, 'utf8').match(LIAO_BASE_READ_RE)
      return m ? m[1] : ''
    }
  } catch {}
  return ''
}

// 校验并归一化用户输入的地址；返回 null 表示放弃改地址
async function askNewBaseUrl() {
  let ans = await ask('要换 API 地址吗？(直接回车=不换，输入新地址=更换)\n  (也可以直接把 sk- 密钥粘在这里): ')
  // 用户把 key 粘到了地址这一问 —— 正常情况，直接当密钥用
  if (KEY_ONLY_RE.test(ans)) return { key: ans, baseUrl: null }

  for (let i = 0; ans && i < 3; i++) {
    if (!/^https?:\/\//i.test(ans)) {
      console.log('[X] 地址要 http:// 或 https:// 开头。')
    } else if (/platform\.deepseek\.com/i.test(ans)) {
      console.log('[X] 这是 DeepSeek 网页地址，不是 API 接口。官方接口是 https://api.deepseek.com/v1')
    } else {
      return { key: null, baseUrl: ans.replace(/\/+$/, '') }
    }
    ans = (await ask('重新输入地址(直接回车=不换): ')).trim()
    if (!ans) break
    if (KEY_ONLY_RE.test(ans)) return { key: ans, baseUrl: null }
  }
  if (ans) console.log('[!] 地址没改，继续问密钥\n')
  else console.log('  地址不变\n')
  return { key: null, baseUrl: null }
}

// DSH 自己那个 relay provider 的地址（.credentials.yaml 里的 RELAY_API_KEY 是给它用的）
function dshRelayBase() {
  try {
    const t = readFileSync(DSH_PROFILE, 'utf8')
    const m = t.match(/relay:[\s\S]*?baseURL:\s*"([^"]+)"/)
    return m ? m[1].replace(/\/+$/, '') : ''
  } catch { return '' }
}

// 是不是官方 DeepSeek 接口（决定用哪套模型名）
function isOfficial(baseUrl) {
  return /api\.deepseek\.com/i.test(String(baseUrl || ''))
}

// 改 Codex 的 config.toml：只动 [model_providers.deepseek] 段里的 base_url 和
// experimental_bearer_token，其他段落（含 deepseek-relay 备份）原样保留。
function patchCodexConfig(baseUrl, apiKey) {
  if (!existsSync(CODEX_CONFIG)) return '[!] 跳过 Codex: 没有 config.toml'
  let t = readFileSync(CODEX_CONFIG, 'utf8')
  // 用「行扫描」定位段：从 [model_providers.deepseek] 那一行起，到下一个 [ 开头的行之前
  const lines = t.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*\[model_providers\.deepseek\]\s*$/.test(l))
  if (start < 0) return '[!] 跳过 Codex: config.toml 里没有 [model_providers.deepseek] 段'
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break }
  }
  let touched = 0
  let found = 0
  for (let i = start + 1; i < end; i++) {
    const b = lines[i]
    let a = b
    if (/(base_url\s*=\s*")[^"]*(")/.test(a)) found++
    if (/(experimental_bearer_token\s*=\s*")[^"]*(")/.test(a)) found++
    a = a.replace(/(base_url\s*=\s*")[^"]*(")/, `$1${baseUrl}$2`)
    a = a.replace(/(experimental_bearer_token\s*=\s*")[^"]*(")/, `$1${apiKey}$2`)
    if (a !== b) { lines[i] = a; touched++ }
  }
  if (!found) return '[!] 跳过 Codex: 段里没找到 base_url / token 字段'
  t = lines.join('\n')
  // 顶层默认模型名也跟着换（否则默认模型还是旧名字，一启动就 400）
  const slugs = isOfficial(baseUrl) ? CODEX_SLUGS.official : CODEX_SLUGS.relay
  t = t.replace(/^model = "[^"]*"/m, `model = "${slugs.flash}"`)
  writeFileSync(CODEX_CONFIG, t, 'utf8')
  return touched
    ? `[OK] Codex config.toml: 地址+密钥已更新(${touched} 行)，默认模型 ${slugs.flash}`
    : `[OK] Codex config.toml: 地址+密钥已是目标值，默认模型 ${slugs.flash}`
}

// 改 Codex 的 models.json：两个槽位（pro / flash）的 slug 换成该服务商的模型名
function patchCodexModels(baseUrl) {
  if (!existsSync(CODEX_MODELS)) return '[!] 跳过 Codex: 没有 models.json'
  const slugs = isOfficial(baseUrl) ? CODEX_SLUGS.official : CODEX_SLUGS.relay
  const j = readJson(CODEX_MODELS)
  const list = j.models || j
  const changed = []
  for (const m of list) {
    // 按「是不是 pro」判断槽位，不依赖当前 slug 拼写
    const isPro = /pro/i.test(String(m.slug || '')) || /pro/i.test(String(m.display_name || ''))
    const target = isPro ? slugs.pro : slugs.flash
    if (m.slug !== target) { changed.push(`${m.slug}→${target}`); m.slug = target }
  }
  writeJson(CODEX_MODELS, j)
  return changed.length
    ? `[OK] Codex models.json: ${changed.join(', ')}`
    : `[OK] Codex models.json: 模型名已是 ${slugs.pro} / ${slugs.flash}`
}

async function main() {
  let cfg = readJson(CONFIG)
  const oldBase = cfg.baseUrl || '(未设置)'
  console.log(`当前 API 地址: ${oldBase}\n`)

  // 1) 先问要不要换地址
  const step1 = await askNewBaseUrl()
  if (step1.baseUrl) {
    cfg.baseUrl = step1.baseUrl
    // 模型名跟着服务商走：官方用 deepseek-flash，中转用 deepseek-v4-flash
    const models = isOfficial(cfg.baseUrl) ? OFFICIAL_MODELS : RELAY_MODELS
    cfg = { ...cfg, ...models }
    console.log(`  模型同步为 ${models.chatModel} / ${models.extractModel}`)
    writeJson(CONFIG, cfg)
    console.log(`[OK] 新地址已写入 config.json: ${cfg.baseUrl}\n`)
  } else {
    console.log('  地址不变\n')
  }

  // 2) 再问 key
  let newKey = step1.key
  if (!newKey) {
    const arg = (process.argv[2] || '').trim()
    newKey = arg || await ask('粘贴新密钥(sk-开头)后回车: ')
  }
  newKey = newKey.trim()
  if (!KEY_ONLY_RE.test(newKey)) {
    console.log('[X] 密钥格式不对: 应该是 sk- 开头的一长串')
    process.exit(1)
  }
  console.log(`\n新密钥: ${newKey.slice(0, 10)}...${newKey.slice(-4)}\n`)

  // 3) 替换所有文件里的 key，同时把 config.json / liao.html 里的 baseUrl 同步好
  const baseChanged = Boolean(step1.baseUrl)
  for (const f of TARGETS) {
    try {
      const isConfig = f === CONFIG
      const isLocal = f === LOCAL_CONFIG
      const isLiao = f === LIAO
      const isSettings = f === SETTINGS

      if (!existsSync(f)) {
        if (isLocal) {
          writeJson(f, { apiKey: newKey })
          console.log('[OK] config.local.json: 新建并写入 apiKey')
        } else {
          console.log(`[!] 跳过(文件不存在): ${f}`)
        }
        continue
      }

      // .credentials.yaml 里的 RELAY_API_KEY 是 DSH 自己的 relay provider 用的，
      // 只有新 key 确实是那家中转的 key 时才同步，别把官方 key 塞进中转配置
      if (f === CREDS) {
        const rb = dshRelayBase()
        const target = String(cfg.baseUrl || '').replace(/\/+$/, '')
        if (rb && target && rb !== target) {
          console.log(`[!] 跳过 .credentials.yaml: DSH 的 relay 地址是 ${rb}，与新 key 的服务商(${target})不一致`)
          continue
        }
      }

      // 中转/官方是不同的 key，别把 A 家 key 塞进 B 家的配置
      if (isSettings || isLiao) {
        const fb = String(baseUrlOf(f)).replace(/\/+$/, '')
        const target = String(cfg.baseUrl || '').replace(/\/+$/, '')
        if (fb && target && fb !== target) {
          console.log(`[!] 跳过 ${f.split('/').pop()}: 它的地址是 ${fb}，与新 key 的服务商(${target})不一致`)
          continue
        }
      }

      const before = readFileSync(f, 'utf8')
      const hits = (before.match(KEY_RE) || []).length

      if (isLiao) {
        writeFileSync(f, replaceLiao(before, { baseUrl: baseChanged ? cfg.baseUrl : null, apiKey: newKey }), 'utf8')
        console.log(`[OK] liao.html: baseUrl${baseChanged ? ' + key' : ''} 已更新 (key ${hits} 处)`)
      } else if (isConfig) {
        const c = JSON.parse(before)
        c.apiKey = newKey
        writeJson(f, c)
        console.log('[OK] config.json: apiKey 已更新')
      } else if (isLocal) {
        const c = JSON.parse(before)
        c.apiKey = newKey
        writeJson(f, c)
        console.log('[OK] config.local.json: apiKey 已更新（server.js 优先读这个）')
      } else if (isSettings) {
        const c = JSON.parse(before)
        c.apiKey = newKey
        writeJson(f, c)
        console.log('[OK] settings.json: apiKey 已更新')
      } else {
        if (!hits) { console.log(`[!] 跳过(没找到密钥): ${f}`); continue }
        writeFileSync(f, before.replace(KEY_RE, newKey), 'utf8')
        console.log(`[OK] 已替换 ${hits} 处: ${f.split('/').pop()}`)
      }
    } catch (e) {
      console.log(`[X] 处理失败 ${f}: ${e.message}`)
    }
  }

  // 4) Codex：config.toml 的地址+密钥、models.json 的模型名，一起换
  console.log('\n同步 Codex 配置...')
  try {
    console.log(patchCodexConfig(cfg.baseUrl, newKey))
    console.log(patchCodexModels(cfg.baseUrl))
  } catch (e) {
    console.log(`[X] Codex 配置更新失败: ${e.message}`)
  }

  // 5) 重启 8788
  // 以前用 powershell Get-NetTCPConnection 取 PID，在部分环境下返回空 —— 结果旧进程没被
  // 杀掉、新进程绑不上端口静默失败，看起来「重启成功」，其实还在用旧 key。改用 netstat 解析。
  console.log('\n重启 8788 服务...')
  let oldPids = []
  try {
    const out = execFileSync('cmd', ['/c', 'netstat -ano'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const local = parts[1] || ''
      const pid = parts[parts.length - 1]
      if (local.endsWith(':8788') && /^\d+$/.test(pid)) oldPids.push(pid)
    }
  } catch {}
  for (const p of oldPids) {
    try { process.kill(Number(p)); console.log(`  已结束旧进程 ${p}`) } catch (e) { console.log(`  [!] 结束进程 ${p} 失败: ${e.message}`) }
  }
  if (!oldPids.length) console.log('  没有在运行的 8788')
  await new Promise((r) => setTimeout(r, 1500))
  spawn('wscript.exe', [VBS], { detached: true, stdio: 'ignore' }).unref()
  console.log('  已拉起新进程')
  await new Promise((r) => setTimeout(r, 3500))

  // 确认新进程真的起来了（端口还在、HTTP 有响应），否则明说，别假装成功
  try {
    const r = await fetch('http://127.0.0.1:8788/liao')
    console.log(`  8788 自检: HTTP ${r.status}${r.status === 401 ? ' (需要密码，正常)' : ''}`)
  } catch (e) {
    console.log(`  [X] 8788 没起来: ${e.message} —— 手动双击 start.vbs 再试`)
  }

  // 5) 用最终地址 + 该地址对应的模型验证
  const verifyModel = cfg.extractModel || 'deepseek-flash'
  console.log(`\n验证新密钥 (${cfg.baseUrl} / ${verifyModel})...`)
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newKey}` },
      body: JSON.stringify({ model: verifyModel,
        messages: [{ role: 'user', content: '只回复两个字: 可用' }], max_tokens: 200 }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {}
      const text = msg.content || msg.reasoning_content || msg.reasoning || ''
      console.log(`[OK] 请求成功, 模型回复: ${String(text).slice(0, 40)}`)
    } else {
      console.log(`[X] 请求失败 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`)
      console.log('  密钥已写入文件, 可能未激活或已用完')
    }
  } catch (e) {
    console.log(`[!] 验证网络出错: ${e.message} (密钥已写入, 稍后可再试)`)
  }
  console.log('\n完成! 聊天页刷新即可；Codex 重启后生效.')
  closeAsk()
}

main().catch((e) => { console.log('出错: ' + e.message); closeAsk(); process.exit(1) })
