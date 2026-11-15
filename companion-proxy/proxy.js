/**
 * 固定入口代理
 *
 * 问题：DSH 每次启动会随机分配端口，聊天页地址跟着变。
 * 做法：这个进程常驻在固定端口 8899，把 /liao 的请求转发给「当前」的 DSH 端口。
 *      DSH 重启换了端口也没关系——转发失败时它会自己重新找。
 *
 * 用法：node proxy.js          （前台，方便看日志）
 *       wscript start.vbs      （后台静默）
 */

const http = require('node:http')
const { execSync } = require('node:child_process')

const LISTEN_PORT = Number(process.env.COMPANION_PROXY_PORT || 8899)
const LISTEN_HOST = process.env.COMPANION_PROXY_HOST || '0.0.0.0'
const PREFIX = '/liao'

let target = null
let discovering = null

function log(...args) {
  const t = new Date().toTimeString().slice(0, 8)
  console.log(`[${t}]`, ...args)
}

function fromEnv() {
  const u = process.env.DSH_WEB_URL
  if (!u) return null
  try {
    const x = new URL(u)
    const port = Number(x.port || 80)
    return Number.isFinite(port) && port > 0 ? { host: '127.0.0.1', port } : null
  } catch {
    return null
  }
}

function listLocalPorts() {
  const ports = new Set()
  try {
    const out = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 6000,
    })
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+\S+/i)
      if (m && /listen/i.test(line)) ports.add(Number(m[1]))
    }
  } catch {}
  if (ports.size) return [...ports]
  // netstat 被本地化或不可用时的兜底
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq \'127.0.0.1\' } | Select-Object -ExpandProperty LocalPort"',
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    )
    for (const line of out.split(/\r?\n/)) {
      const n = Number(line.trim())
      if (Number.isFinite(n) && n > 0) ports.add(n)
    }
  } catch {}
  return [...ports]
}

function probe(port) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const req = http.get(
      { host: '127.0.0.1', port, path: PREFIX, timeout: 900 },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          if (body.length > 600) req.destroy()
        })
        const verdict = () => done(res.statusCode === 200 && body.includes('id="list"'))
        res.on('end', verdict)
        res.on('close', verdict)
      },
    )
    req.on('timeout', () => { req.destroy(); done(false) })
    req.on('error', () => done(false))
  })
}

async function findTarget() {
  if (discovering) return discovering
  discovering = (async () => {
    const tried = []
    const env = fromEnv()
    if (env) {
      tried.push(env.port)
      if (await probe(env.port)) {
        target = env
        log('目标端口（来自环境变量）', env.port)
        return target
      }
    }
    const candidates = listLocalPorts().filter((p) => p !== LISTEN_PORT && !tried.includes(p))
    for (const port of candidates) {
      if (await probe(port)) {
        target = { host: '127.0.0.1', port }
        log('目标端口（自动发现）', port)
        return target
      }
    }
    target = null
    return null
  })().finally(() => { discovering = null })
  return discovering
}

function pickHeaders(src) {
  const out = {}
  for (const [k, v] of Object.entries(src)) {
    const key = k.toLowerCase()
    if (key === 'connection' || key === 'keep-alive' || key === 'transfer-encoding' ||
        key === 'upgrade' || key === 'proxy-connection' || key === 'te' || key === 'trailer') continue
    out[k] = v
  }
  return out
}

function forward(port, req, res, body) {
  return new Promise((resolve) => {
    const headers = pickHeaders(req.headers)
    if (body) headers['content-length'] = String(body.length)
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.url,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, pickHeaders(up.headers))
        up.pipe(res)
        up.on('end', () => resolve(true))
        up.on('error', () => { try { res.end() } catch {} resolve(false) })
      },
    )
    upstream.on('error', () => {
      try { if (!res.headersSent) res.writeHead(502); res.end('bad gateway') } catch {}
      resolve(false)
    })
    if (body) upstream.end(body)
    else upstream.end()
  })
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/'
  if (!url.startsWith(PREFIX)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('只转发了 ' + PREFIX)
    return
  }

  let body = null
  try {
    body = await readBody(req)
  } catch {
    res.writeHead(400)
    res.end('bad body')
    return
  }

  let port = target ? target.port : null
  if (!port) {
    const t = await findTarget()
    port = t ? t.port : null
  }
  if (!port) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"></head>' +
        '<body style="font-family:sans-serif;padding:48px;color:#333;font-size:15px">' +
        '聊天页在等 DSH 起来……<br>2 秒后自动重试。</body></html>',
      )
      return
    }
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('没找到正在运行的 DSH，先把 DSH 打开再刷新。')
    return
  }

  const ok = await forward(port, req, res, body)
  if (ok || res.headersSent) return

  // 端口变了：重新找一次再试
  const t = await findTarget()
  if (!t) {
    try { res.writeHead(503); res.end('没找到正在运行的 DSH') } catch {}
    return
  }
  await forward(t.port, req, res, body)
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`固定入口已启动：http://${LISTEN_HOST}:${LISTEN_PORT}${PREFIX}`)
  findTarget()
})

// 后台每 2 秒探测一次，DSH 一启动就接上，别等用户点进来才找
setInterval(async () => {
  try {
    if (target) {
      const ok = await probe(target.port)
      if (!ok) {
        log('目标端口失效，重新找')
        target = null
      }
    }
    if (!target) await findTarget()
  } catch {}
}, 2000)

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    log(`端口 ${LISTEN_PORT} 已被占用，可能已经有一个在跑了。`)
    process.exit(0)
  }
  log('启动失败', err)
  process.exit(1)
})
