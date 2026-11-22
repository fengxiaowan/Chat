import http from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { apply as applyPlugin } from './companion-plugin/index.js'
const routes = []
const webServer = { register: (r) => { routes.push(r); return () => {} } }
const ctx = { webServer, llm: { stream: async function* () {} }, agentDefaultModel: { currentSelection: () => ({ provider: 'relay', model: 'x' }) } }
applyPlugin(ctx)
function matchRoute(p) { for (const r of routes) if (r.kind === 'exact' && r.path === p) return r; for (const r of routes) if (r.kind === 'prefix' && (p === r.path || p.startsWith(r.path))) return r; return null }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = matchRoute(url.pathname)
  if (!route) { res.writeHead(404); res.end('nf'); return }
  if (route.resource) {
    const request = new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers })
    const resp = await route.resource(request)
    res.writeHead(resp.status || 200, { 'content-type': resp.headers.get('content-type') || 'text/plain' })
    res.end(await resp.text())
    return
  }
  if (route.handler) { await route.handler(req, res); return }
  res.writeHead(405); res.end()
})
server.listen(18786, async () => {
  // 记录目录当前文件
  const dir = './companion-plugin/data/memos'
  const before = new Set(readdirSync(dir).filter(n=>n.endsWith('.json')))
  const body = JSON.stringify({ action:'save', content:'hello world', title:'test' })
  const opts = {
    hostname: '127.0.0.1', port: 18786, path: '/liao/memo', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': 'Basic ' + Buffer.from('user:111').toString('base64'),
    },
  }
  const resp = await new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve({status:res.statusCode, body:d})); })
    r.on('error', reject); r.write(body); r.end();
  })
  console.log('响应:', resp.status, resp.body)
  const after = readdirSync(dir).filter(n=>n.endsWith('.json'))
  const added = after.filter(n=>!before.has(n))
  console.log('新增文件:', added)
  for (const f of added) {
    const j = JSON.parse(readFileSync(dir + '/' + f, 'utf8'))
    console.log('  ', f, '-> content=', JSON.stringify(j.content), 'title=', j.title)
  }
  // 清理本次新增
  for (const f of added) {
    const j = JSON.parse(readFileSync(dir + '/' + f, 'utf8'))
    if (j.content === 'hello world') {
      await new Promise((res2) => { const r = http.request({ hostname:'127.0.0.1', port:18786, path:'/liao/memo', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify({action:'delete',id:j.id})),'Authorization':'Basic '+Buffer.from('user:111').toString('base64')}}, (x)=>x.on('end',res2)); r.end(JSON.stringify({action:'delete',id:j.id})); })
    }
  }
  server.close()
})
