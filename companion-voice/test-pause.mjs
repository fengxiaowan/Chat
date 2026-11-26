// 精确验证：pause(true) → pause(false) 之后，引擎还能不能被唤醒词唤醒。
import { spawn } from 'node:child_process'
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
let phase = 'boot'
createInterface({ input: child.stdout }).on('line', (l) => {
  if (!l.trim()) return
  let o; try { o = JSON.parse(l) } catch { return }
  if (o.event) {
    evs.push(o)
    if (o.event === 'wake' || o.event === 'utterance') console.log(`   [${phase}] ${o.event} ${o.keyword || o.text}`)
    else if (o.event === 'state') console.log(`   [${phase}] state=${o.state}`)
    return
  }
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
  const a = await synth('老婆，今天天气怎么样')
  const b = await synth('老婆，几点了')

  phase = 'A-首轮'
  console.log('=== A 首轮唤醒 ===')
  await send('listen', { wake: true, wakeWords: ['老婆'], noMicrophone: true })
  await send('listen-file', { file: a })
  await sleep(15000)

  phase = 'B-pause开'
  console.log('=== B 播放：pause(true) ===')
  await send('pause', { on: true })
  await sleep(4000)
  phase = 'C-pause关'
  console.log('=== C 播放结束：pause(false) ===')
  await send('pause', { on: false })
  await sleep(2000)

  phase = 'D-二轮'
  console.log('=== D 再说一次「老婆，几点了」 ===')
  const before = evs.length
  await send('listen-file', { file: b })
  await sleep(18000)

  const seg = evs.slice(before)
  const wakes = seg.filter((e) => e.event === 'wake').length
  const utts = seg.filter((e) => e.event === 'utterance').map((e) => e.text)
  console.log('\n===== 结论 =====')
  console.log('第二轮唤醒事件:', wakes)
  console.log('第二轮识别:', JSON.stringify(utts))
  console.log(wakes > 0 ? '✅ pause(false) 后仍可被唤醒词唤醒' : '⚠️ 没有 wake 事件')
}
main().catch((e) => { console.error('❌', e.message); process.exitCode = 1 })
  .finally(() => { try { child.stdin.end() } catch {}; setTimeout(() => { try { child.kill() } catch {} process.exit(process.exitCode || 0) }, 600) })
