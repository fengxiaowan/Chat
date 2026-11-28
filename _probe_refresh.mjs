// 验证：刷新后骰子还在（只要最后是我说的/她回完也算一轮）
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const prof = mkdtempSync(join(tmpdir(), 'edge-rf-'))
const port = 9461
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
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || '').slice(0, 240))
}
await new Promise((r) => { ws.onopen = r })
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:8788/liao/' })
await sleep(6000)
const where = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
console.log('当前页面:', where.result.value)
if (!String(where.result.value).includes('/liao')) {
  // 被重定向了，说明需要凭据；用带凭据的 URL 打开一次拿 cookie
  await send('Page.navigate', { url: 'http://user:111@127.0.0.1:8788/liao/' })
  await sleep(4000)
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/liao/' })
  await sleep(5000)
}

// 场景 A：最后一条是 user（模型卡住后刷新的典型情况）
const a = await send('Runtime.evaluate', {
  expression: `(async () => {
    const now = Date.now();
    localStorage.setItem('companion.history.v3', JSON.stringify([
      { role: 'user', content: '我前面说的话', ts: now - 60000 },
      { role: 'assistant', content: '她的回复', ts: now - 55000 },
      { role: 'user', content: '最后一句是我说的', ts: now },
    ]));
    localStorage.setItem('companion.thread.v1', JSON.stringify('t-test-refresh'));
    return 'seeded';
  })()`,
  returnByValue: true,
})
await send('Page.navigate', { url: 'http://127.0.0.1:8788/liao/' })
await sleep(6500)
const aRes = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    bars: document.querySelectorAll('.regen-bar').length,
    lastMineHasBar: (() => {
      const mine = [...document.querySelectorAll('.row.mine')];
      const last = mine[mine.length-1];
      return last ? !!last.querySelector('.regen-bar') : null;
    })(),
    count: document.querySelector('.regen-count')?.textContent || null,
  })`,
  returnByValue: true,
})
console.log('场景A（最后是我说的）:', aRes.result.value)

// 场景 B：最后是她回完一整轮，且之前重生成过 2 次
const b = await send('Runtime.evaluate', {
  expression: `(async () => {
    const now = Date.now();
    localStorage.setItem('companion.history.v3', JSON.stringify([
      { role: 'user', content: '我问的一句话', ts: now - 30000 },
      { role: 'assistant', content: '她回的第一句', ts: now - 29000 },
      { role: 'assistant', content: '她回的第二句', ts: now - 28000 },
    ]));
    localStorage.setItem('companion.thread.v1', JSON.stringify('t-test-refresh'));
    localStorage.setItem('companion.regen.v1', JSON.stringify({
      userTs: now - 30000, rejected: ['旧版一','旧版二'], current: '', attempt: 2,
      text: '我问的一句话',
    }));
    return 'seeded';
  })()`,
  returnByValue: true,
})
await send('Page.navigate', { url: 'http://127.0.0.1:8788/liao/' })
await sleep(6500)
const bRes = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    bars: document.querySelectorAll('.regen-bar').length,
    count: document.querySelector('.regen-count')?.textContent || null,
  })`,
  returnByValue: true,
})
console.log('场景B（她回完+重生成过2次）:', bRes.result.value)

// 场景 C：最后一条是 user 之后又有新 user（不该有骰子）
await send('Runtime.evaluate', {
  expression: `(() => {
    const now = Date.now();
    localStorage.setItem('companion.history.v3', JSON.stringify([
      { role: 'user', content: '第一句', ts: now - 20000 },
      { role: 'assistant', content: '中间回复', ts: now - 19000 },
      { role: 'user', content: '第二句', ts: now },
    ]));
    return 'seeded';
  })()`,
  returnByValue: true,
})
await send('Page.navigate', { url: 'http://127.0.0.1:8788/liao/' })
await sleep(6500)
const cRes = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    bars: document.querySelectorAll('.regen-bar').length,
    mineCount: document.querySelectorAll('.row.mine').length,
  })`,
  returnByValue: true,
})
console.log('场景C（又是新的一句）:', cRes.result.value)

console.log('错误:', errs.length ? errs.join(' | ') : '(无)')
ws.close(); proc.kill()
