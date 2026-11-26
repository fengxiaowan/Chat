// 验证：唤醒词会不会从识别结果里被剔除。
// 做法：合成「老婆，今天天气怎么样」→ 监听器按唤醒词「老婆」醒来 → 看 utterance 里还剩什么。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ENGINE = 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\native\\voice-engine\\bin\\publish\\win-x64\\too-voice.exe'
const ROOT = 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\.data\\app\\tuling-voice'
const MODELS = 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\.data\\app\\models'
const BUNDLED = 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\resources\\voice\\bundled-models'

const child = spawn(ENGINE, ['--root', ROOT, '--models', MODELS, '--bundled', BUNDLED],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.setDefaultEncoding('utf8')

const pending = new Map()
const events = []
let seq = 0
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return
  let o; try { o = JSON.parse(line) } catch { return }
  if (o.event) { events.push(o); console.log('  [事件]', JSON.stringify(o)); return }
  if (o.id && pending.has(o.id)) {
    const p = pending.get(o.id); pending.delete(o.id)
    if (o.ok === false) p.reject(new Error(o.error)); else p.resolve(o)
  }
})
child.stderr.on('data', (b) => { const s = b.toString().trim(); if (s) console.log('  [log]', s.slice(0, 160)) })

function send(op, extra = {}) {
  const id = 'r' + ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + op)) } }, 90000)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await sleep(800)
  const SENTENCE = '老婆，今天天气怎么样'
  console.log('① 合成测试句：', SENTENCE)
  const syn = await send('synthesize', { text: SENTENCE })
  const wav = join(ROOT, 'speech', syn.speechId + '.wav')
  if (!existsSync(wav)) throw new Error('合成文件不存在')

  console.log('② 用「老婆」作唤醒词开始监听')
  await send('listen', { wake: true, wakeWords: ['老婆'], noMicrophone: true })

  console.log('③ 把语音喂进去')
  await send('listen-file', { file: wav })

  console.log('④ 等 20 秒收集事件…')
  await sleep(20000)

  const wakes = events.filter((e) => e.event === 'wake')
  const utts = events.filter((e) => e.event === 'utterance')
  console.log('\n===== 结果 =====')
  console.log('唤醒事件:', JSON.stringify(wakes))
  console.log('识别到的话:', JSON.stringify(utts.map((u) => u.text)))
  const last = utts.length ? utts[utts.length - 1].text : ''
  console.log('唤醒词是否被剔除:', last.includes('老婆') ? '❌ 没剔除' : '✅ 已剔除')
}

main().catch((e) => console.error('失败:', e.message)).finally(() => {
  try { child.stdin.end() } catch {}
  setTimeout(() => { try { child.kill() } catch {} process.exit(0) }, 600)
})
