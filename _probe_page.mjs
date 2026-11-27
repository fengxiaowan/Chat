// 用 CDP 抓页面控制台与网络错误，判断地图为什么没画出来
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const prof = mkdtempSync(join(tmpdir(), 'edge-cdp-'))
const port = 9333

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${prof}`,
  `--remote-debugging-port=${port}`,
  '--window-size=520,760',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(2500)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const waiting = new Map()
const send = (method, params = {}) => {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((resolve) => waiting.set(msgId, resolve))
}
const logs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('console: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
  }
  if (m.method === 'Log.entryAdded') {
    logs.push(`[${m.params.entry.level}] ${m.params.entry.text}`)
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url
    if (u.includes('.pbf') || u.includes('openfreemap') || u.includes('map-demo') || u.includes('maplibre')) {
      logs.push(`NET ${m.params.response.status} ${u.slice(0, 100)}`)
    }
  }
  if (m.method === 'Network.loadingFailed') {
    logs.push('NETFAIL ' + (m.params.errorText || '') + ' ' + (m.params.requestId || ''))
  }
}
await new Promise((r) => { ws.onopen = r })
send('Runtime.enable'); send('Log.enable'); send('Network.enable')
send('Page.enable')
send('Page.navigate', { url: 'http://user:111@127.0.0.1:8788/liao/map-demo.html' })
await sleep(12000)

// 检查地图状态
const evalRes = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasMapLib: typeof maplibregl !== 'undefined',
    canvas: !!document.querySelector('#map canvas'),
    state: document.getElementById('hud-state').textContent,
    scriptRan: !!window.__mapBooted,
    srcs: window.__mapInst ? Object.keys(window.__mapInst.getStyle().sources) : null,
    zoom: window.__mapInst ? window.__mapInst.getZoom() : null,
    center: window.__mapInst ? window.__mapInst.getCenter() : null,
    loaded: window.__mapInst ? window.__mapInst.loaded() : null,
    srcState: window.__mapInst ? window.__mapInst.getSource('base') && !!window.__mapInst.getSource('base') : null,
  })`,
  returnByValue: true,
})
await sleep(1200)
console.log('--- 日志 ---')
console.log(logs.slice(0, 40).join('\n') || '(无)')
console.log('--- 页面状态 ---')
console.log(JSON.stringify(evalRes && evalRes.result && evalRes.result.value))

// 在页面里直接抓一个瓦片，看能不能通
const tileTest = await send('Runtime.evaluate', {
  expression: `(async () => {
    const url = 'https://tiles.openfreemap.org/backup_planet/20261122_124456_pt/15/' + Math.floor((117.18+180)/360*32768) + '/' + Math.floor((1-Math.log(Math.tan(29.27*Math.PI/180)+1/Math.cos(29.27*Math.PI/180))/Math.PI)/2*32768) + '.pbf';
    try {
      const r = await fetch(url);
      const b = await r.arrayBuffer();
      return JSON.stringify({ url, status: r.status, bytes: b.byteLength });
    } catch (e) { return JSON.stringify({ url, error: String(e) }); }
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
console.log('--- 页面内拉瓦片 ---')
console.log(tileTest && tileTest.result && tileTest.result.value)
ws.close()
proc.kill()
