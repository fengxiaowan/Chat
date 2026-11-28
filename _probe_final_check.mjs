// 最终确认：本地缓存塞入测试消息 → 刷新后不显示
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const prof = mkdtempSync(join(tmpdir(), 'edge-fc-'))
const port = 9471
const proc = spawn(EDGE, [
  '--headless=new', '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, '--window-size=520,820', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(2500)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
let id = 0
const waiting = new Map()
const errs = []
const send = (m, p = {}) => {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method: m, params: p }))
  return new Promise((r) => waiting.set(mid, r))
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || '').slice(0, 200))
}
await new Promise((r) => { ws.onopen = r })
await send('Runtime.enable'); await send('Page.enable')

// 先拿 cookie
await send('Page.navigate', { url: 'http://user:111@127.0.0.1:8788/liao/' })
await sleep(3500)
await send('Page.navigate', { url: 'http://127.0.0.1:8788/liao/' })
await sleep(5000)

// 注入含测试消息的本地缓存
await send('Runtime.evaluate', {
  expression: `(() => {
    const now = Date.now();
    localStorage.setItem('companion.history.v3', JSON.stringify([
      { role: 'user', content: '真实的一句', ts: now - 9000 },
      { role: 'assistant', content: '第2版：累就歇会儿吧，事儿反正在那儿', ts: now - 8000 },
      { role: 'user', content: '今天下午都在改功能，有点累了', ts: now - 7000 },
      { role: 'assistant', content: 'V2：累就歇会儿吧', ts: now - 6000 },
    ]));
    return 'ok';
  })()`,
  returnByValue: true,
})
await send('Page.navigate', { url: 'http://127.0.0.1:8788/liao/' })
await sleep(7000)

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const texts = [...document.querySelectorAll('#list .row .bubble')].map(b => b.textContent.replace('❝','').trim());
    return JSON.stringify({
      total: texts.length,
      hasVersion: texts.some(t => /^(第\\d+版|V\\d+|第一版)[:：]/.test(t)),
      hasTestUser: texts.includes('今天下午都在改功能，有点累了'),
      hasReal: texts.includes('真实的一句'),
    });
  })()`,
  returnByValue: true,
})
console.log(r.result.value)
console.log('错误:', errs.length ? errs.join(' | ') : '(无)')
ws.close(); proc.kill()
