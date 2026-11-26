// 回归测试：连续 3 轮「唤醒 → 识别」，中间穿插播放时的 pause/unpause，
// 验证不会出现「第二轮以后再也听不见」的问题。
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
  if (o.event) { evs.push(o); return }
  if (o.id && pending.has(o.id)) { const p = pending.get(o.id); pending.delete(o.id); o.ok === false ? p.reject(new Error(o.error)) : p.resolve(o) }
})
function send(op, extra = {}) {
  const id = 'r' + ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + op)) } }, 90000)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function synth(text) {
  const s = await send('synthesize', { text })
  const p = join(ROOT, 'speech', s.speechId + '.wav')
  if (!existsSync(p)) throw new Error('合成失败')
  return p
}

// 和 voice-presence 一致：播放前后 pause(true)/pause(false)，且用 try/finally 保证恢复
let paused = false
async function setPaused(on) {
  if (paused === on) return
  paused = on
  await send('pause', { on })
}

async function round(n, wav) {
  const before = evs.length
  // 模拟她说了一句（播放中暂停麦克风），然后恢复
  await setPaused(true)
  await sleep(1200)
  await setPaused(false)
  await sleep(300)
  await send('listen-file', { file: wav })
  // 等到识别结果或超时
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    const seg = evs.slice(before)
    const u = seg.find((e) => e.event === 'utterance')
    if (u) return u.text
    await sleep(300)
  }
  return null
}

async function main() {
  await sleep(900)
  console.log('准备 3 段测试语音…')
  const a = await synth('老婆，第一句测试')
  const b = await synth('老婆，第二句测试')
  const c = await synth('老婆，第三句测试')

  await send('listen', { wake: true, wakeWords: ['老婆'], noMicrophone: true })
  await sleep(500)

  const results = []
  for (let i = 1; i <= 3; i++) {
    const wav = i === 1 ? a : i === 2 ? b : c
    const text = await round(i, wav)
    console.log(`第 ${i} 轮识别：`, JSON.stringify(text))
    results.push(text)
    await sleep(500)
  }

  const ok = results.every((x) => x && x.length > 0)
  console.log('\n===== 结果 =====')
  console.log(results.map((x, i) => `第${i + 1}轮: ${x ? '✅ ' + x : '❌ 没识别出来'}`).join('\n'))
  console.log(ok ? '\n✅ 连续多轮都正常（问题已修复）' : '\n❌ 仍有某轮听不见')
  process.exitCode = ok ? 0 : 1
}
main().catch((e) => { console.error('❌', e.message); process.exitCode = 1 })
  .finally(() => { try { child.stdin.end() } catch {}; setTimeout(() => { try { child.kill() } catch {} process.exit(process.exitCode || 0) }, 600) })
