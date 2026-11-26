// 第二步可行性验证：不用麦克风，全自动跑通「语音 → 识别 → 小喵回复 → 语音播报」闭环。
//
// 流程：
//   1. 启动 too-voice.exe（本地语音引擎）
//   2. 让它把一句测试话合成成 WAV
//   3. 把这段 WAV 喂回它的监听器（listen-file），得到识别文字
//   4. 把识别文字发给现有 8788 后端聊天接口
//   5. 拿到小喵回复，再交给引擎合成语音
//   6. 用系统播放器播出来
//
// 全程不碰现有网页代码，纯新增脚本，随时可以停。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// ---------- 配置 ----------
const ENGINE = process.env.VOICE_ENGINE || 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\native\\voice-engine\\bin\\publish\\win-x64\\too-voice.exe'
const ENGINE_ROOT = process.env.VOICE_ROOT || 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\.data\\app\\tuling-voice'
const ENGINE_MODELS = process.env.VOICE_MODELS || 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\.data\\app\\models'
const ENGINE_BUNDLED = process.env.VOICE_BUNDLED || 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\resources\\voice\\bundled-models'

const SERVER = process.env.LIAO_SERVER || 'http://127.0.0.1:8788'
const AUTH = 'Basic ' + Buffer.from('user:111').toString('base64')

// 想换成别的话，改这里
const TEST_SENTENCE = process.env.TEST_SENTENCE || '小咪，你今天过得开心吗'

if (!existsSync(ENGINE)) {
  console.error('找不到语音引擎：', ENGINE)
  process.exit(1)
}

// ---------- 启动引擎 ----------
const child = spawn(ENGINE, [
  '--root', ENGINE_ROOT,
  '--models', ENGINE_MODELS,
  '--bundled', ENGINE_BUNDLED,
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

child.stdin.setDefaultEncoding('utf8')
const pending = new Map()
const listeners = new Map() // event 名 -> 回调列表
let seq = 0

const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let obj
  try { obj = JSON.parse(line) } catch { return }
  if (obj.event) {
    const cbs = listeners.get(obj.event) || []
    for (const cb of cbs) cb(obj)
    return
  }
  if (obj.id && pending.has(obj.id)) {
    const { resolve, reject } = pending.get(obj.id)
    pending.delete(obj.id)
    if (obj.ok === false) reject(new Error(obj.error || '引擎返回失败'))
    else resolve(obj)
  }
})

child.stderr.on('data', (b) => {
  const s = b.toString('utf8').trim()
  if (s) console.log('  [引擎日志]', s.slice(0, 200))
})

function send(op, extra = {}) {
  const id = 'req-' + ++seq
  const payload = { id, op, ...extra }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify(payload) + '\n')
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('引擎响应超时：' + op)) }
    }, 60000)
  })
}

function once(eventName, ms = 30000) {
  return new Promise((resolve, reject) => {
    const cbs = listeners.get(eventName) || []
    const cb = (e) => {
      listeners.set(eventName, (listeners.get(eventName) || []).filter((x) => x !== cb))
      resolve(e)
    }
    listeners.set(eventName, [...cbs, cb])
    setTimeout(() => reject(new Error('等待事件超时：' + eventName)), ms)
  })
}

// ---------- 后端调用 ----------
async function chat(text) {
  const body = {
    notes: {},
    messages: [{ role: 'user', content: text, ts: Date.now() }],
    tts: false,
  }
  const resp = await fetch(SERVER + '/liao/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
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
        if (evt.type === 'error') throw new Error(evt.message || '聊天出错')
      }
    }
  }
  return bubbles.join('')
}

function playWav(path) {
  return new Promise((resolve) => {
    // 用 Windows 自带播放，避免引第三方依赖
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      `$p=New-Object System.Media.SoundPlayer '${path.replace(/'/g, "''")}'; $p.PlaySync()`],
    { windowsHide: true })
    ps.on('exit', () => resolve())
    ps.on('error', () => resolve())
  })
}

// ---------- 主流程 ----------
async function main() {
  console.log('① 启动语音引擎…')
  await once('state', 30000).catch(() => {})
  // 引擎启动时会先发 ready，这里等一小会确保就绪
  await new Promise((r) => setTimeout(r, 500))

  console.log('② 合成测试语音：', JSON.stringify(TEST_SENTENCE))
  const synth = await send('synthesize', { text: TEST_SENTENCE })
  const userWav = join(ENGINE_ROOT, 'speech', synth.speechId + '.wav')
  console.log('   合成文件：', userWav, existsSync(userWav) ? '(存在)' : '(不存在!)')

  console.log('③ 让引擎开始监听（不要求唤醒词，直接醒着）…')
  await send('listen', { wake: false })

  console.log('④ 把刚才那段语音喂回监听器，等它识别…')
  const utterancePromise = once('utterance', 60000)
  await send('listen-file', { file: userWav })
  const heard = await utterancePromise
  console.log('   识别结果：', JSON.stringify(heard.text))

  console.log('⑤ 把识别文字发给小喵…')
  const reply = await chat(heard.text)
  console.log('   小喵回复：', JSON.stringify(reply))
  if (!reply) throw new Error('小喵没有回复内容')

  console.log('⑥ 把回复合成成语音并播放…')
  const replySynth = await send('synthesize', { text: reply })
  const replyWav = join(ENGINE_ROOT, 'speech', replySynth.speechId + '.wav')
  if (!existsSync(replyWav)) throw new Error('回复语音没生成出来')
  const size = readFileSync(replyWav).length
  console.log('   语音文件：', replyWav, `(${(size / 1024).toFixed(1)} KB)`)

  console.log('⑦ 播放（你应该能听到她的声音）…')
  await playWav(replyWav)

  console.log('\n✅ 闭环跑通：说话 → 识别 → 回复 → 出声')
}

main()
  .catch((e) => {
    console.error('\n❌ 失败：', e.message)
    process.exitCode = 1
  })
  .finally(() => {
    try { child.stdin.end() } catch {}
    setTimeout(() => { try { child.kill() } catch {} process.exit(process.exitCode || 0) }, 800)
  })
