// 验证「第二轮唤醒失灵」的假设：pause 之后引擎是否还能再次被唤醒。
// 会连续做两次「唤醒 → 识别」，中间模拟播放时的 pause/unpause。
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
const evs = []
let seq = 0
createInterface({ input: child.stdout }).on('line', (l) => {
  if (!l.trim()) return
  let o; try { o = JSON.parse(l) } catch { return }
  if (o.event) { evs.push(o); console.log('   [事件]', o.event, o.state || o.keyword || o.text || '') ; return }
  if (o.id && pending.has(o.id)) { const p = pending.get(o.id); pending.delete(o.id); o.ok === false ? p.reject(new Error(o.error)) : p.resolve(o) }
})
function send(op, extra = {}) {
  const id = 'r' + ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + op)) } }, 60000)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function synth(text) {
  const s = await send('synthesize', { text })
  return join(ROOT, 'speech', s.speechId + '.wav')
}

async function main() {
  await sleep(900)
  const w1 = await synth('老婆，今天天气怎么样')
  const w2 = await synth('老婆，你在干什么')
  if (!existsSync(w1) || !existsSync(w2)) throw new Error('合成失败')

  console.log('=== 第一轮 ===')
  await send('listen', { wake: true, wakeWords: ['老婆'], noMicrophone: true })
  await send('listen-file', { file: w1 })
  await sleep(16000)

  console.log('=== 模拟她说话（pause → unpause）===')
  await send('pause', { on: true })
  await sleep(3500)
  await send('pause', { on: false })
  await sleep(1000)

  console.log('=== 第二轮（不改任何东西，直接再喂）===')
  evs.length = 0
  await send('listen-file', { file: w2 })
  await sleep(16000)

  const utts = evs.filter((e) => e.event === 'utterance')
  const wakes = evs.filter((e) => e.event === 'wake')
  console.log('\n第二轮结果：唤醒次数 =', wakes.length, '识别到 =', JSON.stringify(utts.map((u) => u.text)))
  console.log(wakes.length > 0 ? '✅ pause 后仍能被唤醒' : '❌ pause 后无法再被唤醒（问题复现）')
}
main().catch((e) => { console.error('❌', e.message); process.exitCode = 1 })
  .finally(() => { try { child.stdin.end() } catch {}; setTimeout(() => { try { child.kill() } catch {} process.exit(process.exitCode || 0) }, 600) })
