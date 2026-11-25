// swap-key script: double-click swapkey.bat
// 流程：先问要不要换 API 地址（换则写入 config.json + liao.html），
// 再问新 key，替换各文件里的 sk- 密钥，重启 8788，用最终地址验证。
//
// 2026-11 修复：
//  1) 地址那一问也可以直接粘 sk- 密钥（以前会报「地址要以 http:// 开头」直接退出）
//  2) 地址填错不再 exit，而是重问；并拦截 platform.deepseek.com 网页地址
//  3) 切到官方接口时自动把模型名换成官方名
//  4) 补上 config.local.json —— server.js 里它优先级最高，以前从不更新它，
//     所以 key 写进 config.json 也「换不上」
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
const KEY_RE = /sk-[A-Za-z0-9\-_]{20,}/g
const KEY_ONLY_RE = /^sk-[A-Za-z0-9\-_]{20,}$/
// liao.html 里写死的 baseUrl / apiKey 两行，精确匹配替换
const LIAO_BASE_RE = /("baseUrl"\s*:\s*")[^"]*(")/
const LIAO_KEY_RE = /("apiKey"\s*:\s*")[^"]*(")/
const LIAO_BASE_READ_RE = /"baseUrl"\s*:\s*"([^"]*)"/

// 官方接口对应的模型名（中转站那套 deepseek-v4-flash 在官方也叫 deepseek-flash）
const OFFICIAL_MODELS = { chatModel: 'deepseek-v4-pro', extractModel: 'deepseek-flash' }

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

async function main() {
  let cfg = readJson(CONFIG)
  const oldBase = cfg.baseUrl || '(未设置)'
  console.log(`当前 API 地址: ${oldBase}\n`)

  // 1) 先问要不要换地址
  const step1 = await askNewBaseUrl()
  if (step1.baseUrl) {
    cfg.baseUrl = step1.baseUrl
    if (/api\.deepseek\.com/i.test(cfg.baseUrl)) {
      cfg = { ...cfg, ...OFFICIAL_MODELS }
      console.log(`  已切到官方接口，模型同步为 ${OFFICIAL_MODELS.chatModel} / ${OFFICIAL_MODELS.extractModel}`)
    }
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

  // 4) 重启 8788
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
  console.log('\n完成! 刷新聊天页即可使用.')
  closeAsk()
}

main().catch((e) => { console.log('出错: ' + e.message); closeAsk(); process.exit(1) })
