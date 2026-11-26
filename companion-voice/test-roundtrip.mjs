// 全自动验证 voice-presence 的整条链路（不需要麦克风）：
//   合成「老婆，今天天气怎么样」→ 引擎唤醒+识别 → 聊天 → edge-tts 播放
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const ENGINE = 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\native\\voice-engine\\bin\\publish\\win-x64\\too-voice.exe'
const ROOT = 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\.data\\app\\tuling-voice'
const MODELS = 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\.data\\app\\models'
const BUNDLED = 'D:\\收藏\\TooDesktop-main\\TooDesktop-main\\resources\\voice\\bundled-models'
const SERVER = 'http://127.0.0.1:8788'
const AUTH = 'Basic ' + Buffer.from('user:111').toString('base64')

const child = spawn(ENGINE, ['--root', ROOT, '--models', MODELS, '--bundled', BUNDLED],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.setDefaultEncoding('utf8')
const pending = new Map(); const events = []
let seq = 0
createInterface({ input: child.stdout }).on('line', (l) => {
  if (!l.trim()) return
  let o; try { o = JSON.parse(l) } catch { return }
  if (o.event) { events.push(o); return }
  if (o.id && pending.has(o.id)) { const p = pending.get(o.id); pending.delete(o.id); o.ok === false ? p.reject(new Error(o.error)) : p.resolve(o) }
})
child.stderr.on('data', (b) => { const s = b.toString().trim(); if (s) console.log('  [引擎]', s.slice(0, 140)) })
function send(op, extra = {}) {
  const id = 'r' + ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + op)) } }, 90000)
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function chat(text) {
  const resp = await fetch(SERVER + '/liao/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AUTH },
    body: JSON.stringify({ notes: {}, messages: [{ role: 'user', content: text, ts: Date.now() }], tts: false }),
  })
  const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''; const out = []
  while (true) {
    const { value, done } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true }); let cut
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const blk = buf.slice(0, cut); buf = buf.slice(cut + 2)
      for (const line of blk.split('\n')) {
        if (!line.startsWith('data:')) continue
        let e; try { e = JSON.parse(line.slice(5).trim()) } catch { continue }
        if (e.type === 'bubble') out.push(e.text)
        if (e.type === 'error') throw new Error(e.message)
      }
    }
  }
  return out.join('')
}

async function main() {
  await sleep(900)
  console.log('① 合成「老婆，今天天气怎么样」')
  const syn = await send('synthesize', { text: '老婆，今天天气怎么样' })
  const wav = join(ROOT, 'speech', syn.speechId + '.wav')
  if (!existsSync(wav)) throw new Error('合成失败')

  console.log('② 唤醒词「老婆」监听，喂入语音')
  await send('listen', { wake: true, wakeWords: ['老婆'], noMicrophone: true })
  await send('listen-file', { file: wav })
  await sleep(18000)

  const utt = events.filter((e) => e.event === 'utterance').pop()
  console.log('③ 识别结果：', JSON.stringify(utt && utt.text))
  if (!utt) throw new Error('没识别出内容')

  console.log('④ 问小喵…')
  const reply = await chat(utt.text)
  console.log('   她说：', JSON.stringify(reply))
  if (!reply) throw new Error('没有回复')

  console.log('⑤ 用 edge-tts（和她网页同一个声音）合成')
  const ttsUrl = SERVER + '/liao/tts?text=' + encodeURIComponent(reply.slice(0, 300))
  const r = await fetch(ttsUrl, { headers: { Authorization: AUTH } })
  const bytes = Buffer.from(await r.arrayBuffer())
  console.log(`   TTS: HTTP ${r.status}, ${(bytes.length / 1024).toFixed(1)} KB`)
  if (bytes.length < 1000) throw new Error('TTS 音频太小')

  console.log('\n✅ 全链路通过：唤醒 → 识别 → 聊天 → 声音（与你网页同一个声线）')
}
main().catch((e) => { console.error('❌', e.message); process.exitCode = 1 })
  .finally(() => { try { child.stdin.end() } catch {}; setTimeout(() => { try { child.kill() } catch {} process.exit(process.exitCode || 0) }, 600) })
