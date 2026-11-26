// 小喵 · 桌面语音常驻（唤醒词版）
//
// 在后台常驻，不用开网页窗口。说「老婆」唤醒，说完自动识别、发给小喵、用她平时那个声音读出来。
//
// 组成：
//   - too-voice.exe：本机语音引擎，负责唤醒词 + 语音识别（WASAPI 直接抓麦克风，不受浏览器限制）
//   - 8788 后端：现有聊天接口
//   - edge-tts（/liao/tts）：和网页完全同一个声音
//
// 用法：node voice-presence.mjs
// 退出：Ctrl+C

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'

// ---------- 配置 ----------
const cfg = {
  engine: process.env.VOICE_ENGINE || 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\native\\voice-engine\\bin\\publish\\win-x64\\too-voice.exe',
  engineRoot: process.env.VOICE_ROOT || 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\.data\\app\\tuling-voice',
  engineModels: process.env.VOICE_MODELS || 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\.data\\app\\models',
  engineBundled: process.env.VOICE_BUNDLED || 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\resources\\voice\\bundled-models',
  server: process.env.LIAO_SERVER || 'http://127.0.0.1:8788',
  auth: 'Basic ' + Buffer.from('user:111').toString('base64'),
  wakeWord: process.env.WAKE_WORD || '老婆',
  historyTurns: 30,
  // 状态文件：给悬浮小球读取，让你随时看到她在干嘛
  stateFile: join(tmpdir(), 'xiaomiao-voice', 'state.json'),
  logFile: join(tmpdir(), 'xiaomiao-voice', 'presence.log'),
  // 安全阈值：暂停超过这个时间就强制恢复，避免卡死在「听不见」的状态
  maxPauseMs: 20000,
}

if (!existsSync(cfg.engine)) {
  console.error('找不到语音引擎：', cfg.engine)
  process.exit(1)
}

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8)
  const line = `[${t}] ${a.join(' ')}`
  console.log(line)
  try { appendFileSync(cfg.logFile, line + '\n') } catch {}
}

// ---------- 状态上报 ----------
// idle（睡着的，等唤醒词）/ hearing（在听你说）/ thinking（在想）/ speaking（在说）/ error
let currentState = 'idle'
function setState(state) {
  if (currentState === state) return
  currentState = state
  try {
    writeFileSync(cfg.stateFile, JSON.stringify({ state, at: Date.now(), wake: cfg.wakeWord }))
  } catch {}
}

// ---------- 语音引擎 ----------
const child = spawn(cfg.engine, [
  '--root', cfg.engineRoot,
  '--models', cfg.engineModels,
  '--bundled', cfg.engineBundled,
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.setDefaultEncoding('utf8')

const pending = new Map()
const eventHandlers = new Map()
let seq = 0
let engineReady = false

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let o
  try { o = JSON.parse(line) } catch { return }
  if (o.ready) { engineReady = true; return }
  if (o.event) {
    for (const cb of eventHandlers.get(o.event) || []) cb(o)
    return
  }
  if (o.id && pending.has(o.id)) {
    const p = pending.get(o.id); pending.delete(o.id)
    if (o.ok === false) p.reject(new Error(o.error || '引擎失败')); else p.resolve(o)
  }
})
child.stderr.on('data', (b) => {
  const s = b.toString('utf8').trim()
  if (s && !/^\d\d:\d\d:\d\d\s*$/.test(s)) log('引擎:', s.slice(0, 200))
})
child.on('exit', (code) => {
  log(`引擎退出（code=${code}），3 秒后重启`)
  setTimeout(() => startListening(), 3000)
})

function send(op, extra = {}) {
  const id = 'r' + ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + op)) } }, 60000)
  })
}

function on(eventName, cb) {
  if (!eventHandlers.has(eventName)) eventHandlers.set(eventName, [])
  eventHandlers.get(eventName).push(cb)
}

// ---------- 对话 ----------
const history = [] // [{role, content, ts}]，只在本次进程内保留

async function askXiaomiao(text) {
  history.push({ role: 'user', content: text, ts: Date.now() })
  const body = {
    notes: {},
    messages: history.slice(-cfg.historyTurns),
    tts: false,
  }
  const resp = await fetch(cfg.server + '/liao/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: cfg.auth },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error('聊天接口 HTTP ' + resp.status)
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const bubbles = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let cut
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut)
      buf = buf.slice(cut + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        let evt
        try { evt = JSON.parse(line.slice(5).trim()) } catch { continue }
        if (evt.type === 'bubble' && evt.text) bubbles.push(evt.text)
        else if (evt.type === 'error') throw new Error(evt.message || '聊天出错')
      }
    }
  }
  const reply = bubbles.join('')
  if (reply) history.push({ role: 'assistant', content: reply, ts: Date.now() })
  return reply
}

// ---------- 播放（用网页同一个 edge-tts 声音） ----------
const TTS_DIR = join(tmpdir(), 'xiaomiao-voice')
try { mkdirSync(TTS_DIR, { recursive: true }) } catch {}

let playProc = null
let pausedAt = 0
let paused = false
// 每次播放一个唯一标记：被打断时标记失效，旧播放就不会再动 pause 状态
let playToken = 0

function stopPlayback() {
  playToken++
  if (playProc) { try { playProc.kill() } catch {} playProc = null }
}

// 统一的暂停/恢复：任何异常都要能恢复，避免永久听不见
async function setPaused(on) {
  if (paused === on) return
  paused = on
  pausedAt = on ? Date.now() : 0
  try { await send('pause', { on }) } catch (e) { log('pause 失败：', e.message) }
}

// 兜底：如果暂停超过阈值，强制恢复，防止卡死
setInterval(() => {
  if (paused && pausedAt && Date.now() - pausedAt > cfg.maxPauseMs) {
    log('⚠️ 暂停超时，强制恢复监听')
    setPaused(false)
  }
}, 2000)

async function speak(text) {
  if (!text.trim()) return
  const token = ++playToken
  const url = cfg.server + '/liao/tts?text=' + encodeURIComponent(text.slice(0, 300))
  const resp = await fetch(url, { headers: { Authorization: cfg.auth } })
  if (!resp.ok) throw new Error('TTS HTTP ' + resp.status)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 1000) throw new Error('TTS 返回为空')
  if (token !== playToken) return // 取音频期间被打断
  const file = join(TTS_DIR, 'say-' + Date.now() + '.mp3')
  writeFileSync(file, buf)

  setState('speaking')
  // 播放期间暂停麦克风，避免听见自己的声音（引擎没有回声消除）
  await setPaused(true)
  try {
    await new Promise((resolve) => {
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName presentationCore;` +
        `$p=New-Object System.Windows.Media.MediaPlayer;` +
        `$p.Open([Uri]'${file.replace(/'/g, "''")}');` +
        `$p.Play();` +
        `$n=0; while(-not $p.NaturalDuration.HasTimeSpan -and $n -lt 100){Start-Sleep -Milliseconds 100; $n++};` +
        `if($p.NaturalDuration.HasTimeSpan){$ms=$p.NaturalDuration.TimeSpan.TotalMilliseconds; Start-Sleep -Milliseconds ([int]$ms+250)} else {Start-Sleep -Seconds 3};` +
        `$p.Stop(); $p.Close()`,
      ], { windowsHide: true })
      playProc = ps
      ps.on('exit', () => { playProc = null; resolve() })
      ps.on('error', () => { playProc = null; resolve() })
    })
  } finally {
    // 只有「当前这一轮」才恢复监听：被打断时由打断方接管，避免互相覆盖
    if (token === playToken) {
      await setPaused(false)
      setState('idle')
    }
  }
}

// ---------- 一���完整回合 ----------
let busy = false

// 引擎把「图零零」当固定名字做纠错，会把别的话错误改成它。
// 这里做逆向清洗：把明显的引擎臆测词还原/去掉。
const WAKE_VARIANTS = ['老婆', '小咪', '小喵']
const ENGINE_NAME_NOISE = ['图零零', '图零', '零图', '零零', '兔零零', '涂零零', '图灵灵']

function sanitizeHeard(raw) {
  let t = String(raw || '').trim()
  if (!t) return t
  // 引擎名字噪音出现在句首时直接去掉（那是它把唤醒词臆想成了它的名字）
  for (const n of ENGINE_NAME_NOISE) {
    if (t.startsWith(n)) { t = t.slice(n.length).replace(/^[，,。、\s]+/, ''); break }
  }
  // 再保险：把夹在中间的名字噪音也移除
  for (const n of ENGINE_NAME_NOISE) t = t.replaceAll(n, '')
  return t.replace(/\s{2,}/g, ' ').trim()
}

async function handleUtterance(text) {
  if (busy) { log('还在处理上一句，忽略：', text); return }
  const cleaned = sanitizeHeard(text)
  if (!cleaned) { log('识别结果清洗后为空，忽略：', text); return }
  text = cleaned
  busy = true
  try {
    setState('thinking')
    log('听到：', JSON.stringify(text))
    const reply = await askXiaomiao(text)
    log('她说：', JSON.stringify(reply))
    if (reply) await speak(reply)
  } catch (e) {
    log('出错：', e.message)
    setState('error')
  } finally {
    busy = false
    // 只有没被打断才回到空闲；被打断时新一轮已经接管状态
    if (!busy && currentState === 'error') setTimeout(() => { if (!busy) setState('idle') }, 1200)
    else if (!busy) setState('idle')
  }
}

// ---------- 启动监听 ----------
async function startListening() {
  try {
    await send('listen', { wake: true, wakeWords: [cfg.wakeWord] })
    log(`已就绪。说「${cfg.wakeWord}」唤醒她。`)
  } catch (e) {
    log('启动监听失败：', e.message, '（5 秒后重试）')
    setTimeout(() => startListening(), 5000)
  }
}

// 被唤醒：如果你是在她说话/思考时喊她，应当「打断」并立刻开始听你说
on('wake', (e) => {
  log(`被唤醒（${e.keyword}）`)
  if (busy || paused) {
    log('打断当前回合，重新开始听')
    stopPlayback()
    busy = false
    setPaused(false)
    setState('hearing')
  }
})
on('utterance', (e) => { handleUtterance(e.text) })
on('error', (e) => log('引擎报错：', e.message))

// 引擎状态同步到状态文件，供悬浮球显示。
// 注意只采纳「空闲/在听」，因为我们自己的 thinking / speaking 比引擎的更准确。
on('state', (e) => {
  if (busy) return
  if (e.state === 'hearing') setState('hearing')
  else if (e.state === 'sleeping' || e.state === 'awake' || e.state === 'off') setState('idle')
})

const waitReady = setInterval(() => {
  if (engineReady) {
    clearInterval(waitReady)
    startListening()
  }
}, 200)

process.on('SIGINT', () => {
  log('收到 Ctrl+C，退出')
  stopPlayback()
  try { child.stdin.end() } catch {}
  setTimeout(() => { try { child.kill() } catch {} process.exit(0) }, 500)
})
