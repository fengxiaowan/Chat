// 验证「通话模式」开关：listen → stop-listening → listen 反复 4 次，
// 确认每次都能重新进入监听、且能正常识别（不会因为反复开关而失灵）。
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
child.stderr.on('data', (b) => { const s = b.toString().trim(); if (s) console.log('  [eng]', s.slice(0, 140)) })
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
  const wav = await synth('老婆，第几轮了')
  if (!existsSync(wav)) throw new Error('合成失败')

  const results = []
  for (let i = 1; i <= 4; i++) {
    console.log(`\n=== 第 ${i} 次：开启通话 → 说话 → 关闭 ===`)
    const before = evs.length
    await send('listen', { wake: true, wakeWords: ['老婆'], noMicrophone: true })
    await sleep(300)
    await send('listen-file', { file: wav })

    let text = null
    const t0 = Date.now()
    while (Date.now() - t0 < 18000) {
      const u = evs.slice(before).find((e) => e.event === 'utterance')
      if (u) { text = u.text; break }
      await sleep(300)
    }
    const seg = evs.slice(before)
    console.log(`  唤醒=${seg.filter(e=>e.event==='wake').length} 识别=${JSON.stringify(text)}`)
    results.push(text)

    // 关闭通话模式
    await send('stop-listening')
    await sleep(500)
  }

  const ok = results.every((x) => x)
  console.log('\n===== 结果 =====')
  results.forEach((r, i) => console.log(`第${i + 1}次: ${r ? '✅ ' + r : '❌ 失败'}`))
  console.log(ok ? '\n✅ 反复开关监听可靠' : '\n❌ 有失败')
  process.exitCode = ok ? 0 : 1
}
main().catch((e) => { console.error('❌', e.message); process.exitCode = 1 })
  .finally(() => { try { child.stdin.end() } catch {}; setTimeout(() => { try { child.kill() } catch {} process.exit(process.exitCode || 0) }, 600) })
