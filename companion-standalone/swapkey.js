// swap-key script: double-click swapkey.bat
// 流程：先问要不要换 API 地址（换则写入 config.json + liao.html），
// 再问新 key，替换 4 个文件里的 sk- 密钥，重启 8788，用最终地址验证。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const ROOT = 'C:/Users/lyy44/Documents/deepseek-harness/default-workspace'
const CONFIG = `${ROOT}/companion-standalone/config.json`
const TARGETS = [
  'C:/Users/lyy44/.dsh/.credentials.yaml',
  `${ROOT}/companion-standalone/config.json`,
  `${ROOT}/companion-offline/settings.json`,
  `${ROOT}/companion-offline/liao.html`,
]
const VBS = `${ROOT}/companion-standalone/start.vbs`
const KEY_RE = /sk-[A-Za-z0-9\-_]{20,}/g
// liao.html 里写死的 baseUrl / apiKey 两行，精确匹配替换
const LIAO_BASE_RE = /("baseUrl"\s*:\s*")[^"]*(")/
const LIAO_KEY_RE = /("apiKey"\s*:\s*")[^"]*(")/

function readConfig() {
  return JSON.parse(readFileSync(CONFIG, 'utf8'))
}
function writeConfig(cfg) {
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()) }))
}

// 把 liao.html 里的 baseUrl / apiKey 换成新值（按行精确替换，不动其他内容）
function replaceLiao(html, { baseUrl, apiKey }) {
  if (baseUrl) html = html.replace(LIAO_BASE_RE, `$1${baseUrl}$2`)
  if (apiKey) html = html.replace(LIAO_KEY_RE, `$1${apiKey}$2`)
  return html
}

async function main() {
  const cfg = readConfig()
  const oldBase = cfg.baseUrl || '(未设置)'
  console.log(`当前 API 地址: ${oldBase}\n`)

  // 1) 先问要不要换地址
  const ans = await ask('要换 API 地址吗？(直接回车=不换，输入新地址=更换): ')
  if (ans) {
    // 用户自己写全地址，不自动补 /v1
    if (!/^https?:\/\//i.test(ans)) {
      console.log('[X] 地址要以 http:// 或 https:// 开头')
      process.exit(1)
    }
    cfg.baseUrl = ans.replace(/\/+$/, '') // 去掉结尾多余斜杠
    writeConfig(cfg)
    console.log(`[OK] 新地址已写入 config.json: ${cfg.baseUrl}\n`)
  } else {
    console.log('  地址不变\n')
  }

  // 2) 再问 key
  const arg = (process.argv[2] || '').trim()
  const newKey = arg || await ask('粘贴新密钥(sk-开头)后回车: ')
  if (!/^sk-[A-Za-z0-9\-_]{20,}$/.test(newKey)) {
    console.log('[X] 密钥格式不对: 应该是 sk- 开头的一长串')
    process.exit(1)
  }
  console.log(`\n新密钥: ${newKey.slice(0, 10)}...${newKey.slice(-4)}\n`)

  // 3) 替换所有文件里的 key，同时把 config.json / liao.html 里的 baseUrl 同步好
  for (const f of TARGETS) {
    try {
      const before = readFileSync(f, 'utf8')
      const isConfig = f.endsWith('config.json')
      const isLiao = f.endsWith('liao.html')
      const hits = (before.match(KEY_RE) || []).length

      if (isLiao) {
        // liao.html：同时换 baseUrl（若已换）和 apiKey
        writeFileSync(f, replaceLiao(before, { baseUrl: ans ? cfg.baseUrl : null, apiKey: newKey }), 'utf8')
        console.log(`[OK] liao.html: baseUrl${ans ? ' + key' : ''} 已更新 (key ${hits} 处)`)
      } else if (isConfig) {
        // config.json：baseUrl 已在上一步写入，这里确保 apiKey 也换成新的
        const c = JSON.parse(before)
        c.apiKey = newKey
        writeFileSync(f, JSON.stringify(c, null, 2) + '\n', 'utf8')
        console.log(`[OK] config.json: apiKey 已更新`)
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
  console.log('\n重启 8788 服务...')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue).OwningProcess'],
      { encoding: 'utf8' }).trim()
    const pids = out.split(/\s+/).filter(Boolean)
    for (const p of pids) { try { process.kill(Number(p)) } catch {} }
    if (pids.length) console.log(`  已结束旧进程 ${pids.join(',')}`)
    else console.log('  没有在运行的 8788')
  } catch { console.log('  没有在运行的 8788') }
  await new Promise((r) => setTimeout(r, 1500))
  spawn('wscript.exe', [VBS], { detached: true, stdio: 'ignore' }).unref()
  console.log('  已拉起新进程')
  await new Promise((r) => setTimeout(r, 3500))

  // 5) 用最终地址验证
  console.log('\n验证新密钥...')
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${newKey}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '只回复两个字: 可用' }], max_tokens: 20 }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      console.log(`[OK] 请求成功, 模型回复: ${data.choices?.[0]?.message?.content || ''}`)
    } else {
      console.log(`[X] 请求失败 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`)
      console.log('  密钥已写入文件, 可能未激活或已用完')
    }
  } catch (e) {
    console.log(`[!] 验证网络出错: ${e.message} (密钥已写入, 稍后可再试)`)
  }
  console.log('\n完成! 刷新聊天页即可使用.')
}

main().catch((e) => { console.log('出错: ' + e.message); process.exit(1) })
