// swap-key script: double-click swapkey.bat
// Replaces every sk-... key in the 4 config files, restarts the 8788 chat
// service, then verifies the new key with a real request.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const ROOT = 'C:/Users/lyy44/Documents/deepseek-harness/default-workspace'
const TARGETS = [
  'C:/Users/lyy44/.dsh/.credentials.yaml',
  `${ROOT}/companion-standalone/config.json`,
  `${ROOT}/companion-offline/settings.json`,
  `${ROOT}/companion-offline/liao.html`,
]
const VBS = `${ROOT}/companion-standalone/start.vbs`
const BASE_URL = 'https://tmai.ak03.cn/v1'
const KEY_RE = /sk-[A-Za-z0-9\-_]{20,}/g

async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()) }))
}

async function main() {
  const arg = (process.argv[2] || '').trim()
  const newKey = arg || await ask('粘贴新密钥(sk-开头)后回车: ')
  if (!/^sk-[A-Za-z0-9\-_]{20,}$/.test(newKey)) {
    console.log('[X] 密钥格式不对: 应该是 sk- 开头的一长串')
    process.exit(1)
  }
  console.log(`\n新密钥: ${newKey.slice(0, 10)}...${newKey.slice(-4)}\n`)

  // 1) replace in all files
  for (const f of TARGETS) {
    try {
      const before = readFileSync(f, 'utf8')
      const hits = (before.match(KEY_RE) || []).length
      if (!hits) { console.log(`[!] 跳过(没找到密钥): ${f}`); continue }
      writeFileSync(f, before.replace(KEY_RE, newKey), 'utf8')
      console.log(`[OK] 已替换 ${hits} 处: ${f.split('/').pop()} (${f.split('/').slice(-2,-1)})`)
    } catch (e) {
      console.log(`[X] 读取失败 ${f}: ${e.message}`)
    }
  }

  // 2) restart 8788
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

  // 3) verify with a real request
  console.log('\n验证新密钥...')
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
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
