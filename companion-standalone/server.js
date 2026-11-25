// 独立版：不依赖 DSH，直接跑 companion 插件逻辑，模型调用走 OpenAI 兼容中转。
//
// 原理：插件只依赖三个 DSH 服务（webServer.register / llm.stream / agentDefaultModel），
// 这里用一个很小的"模拟环境"实现它们，然后把插件的 apply() 原样跑起来。
import http from 'node:http'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply as applyPlugin } from '../companion-plugin/index.js'

const CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url))
const LOCAL_CONFIG_PATH = fileURLToPath(new URL('./config.local.json', import.meta.url))
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
// 敏感配置（密钥）放在被 gitignore 的 config.local.json，公开配置留 config.json
const localConfig = existsSync(LOCAL_CONFIG_PATH)
  ? JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf8'))
  : {}

const BASE_URL = String(config.baseUrl || '').replace(/\/+$/, '')
const API_KEY = String(localConfig.apiKey || config.apiKey || '')
const CHAT_MODEL = config.chatModel || 'deepseek-v4-pro'
const EXTRACT_MODEL = config.extractModel || 'deepseek-v4-flash'
const PORT = Number(config.port || 8788)
const LOG_PATH = fileURLToPath(new URL('./server.log', import.meta.url))
// 出错留痕：以前进程是 wscript 静默拉起的，报错全丢，出问题只能猜。
function logLine(tag, text) {
  try { appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${tag} ${String(text).slice(0, 400).replace(/\s+/g, ' ')}\n`) } catch {}
}

// 把插件的 DSH 模型名映射到中转的模型名
function mapModel(model) {
  const m = String(model || '')
  if (/flash/i.test(m)) return EXTRACT_MODEL
  if (/pro/i.test(m)) return CHAT_MODEL
  return m || CHAT_MODEL
}

// 判断是否是「额度耗尽/余额不足」类错误（日卡到期、积分用完）。
// 防御式识别：既看 HTTP 状态码，也看 body 里的关键词，兜住 relay 的各种返回。
function isQuotaError(status, text) {
  const s = Number(status || 0)
  const body = String(text || '').toLowerCase()
  if (s === 402 || s === 403 || s === 429) {
    // 402/403/429 也可能是限流，需要结合 body 判断；但若无 body 信息，402 直接视为额度问题
    if (s === 402) return true
    if (/insufficient|balance|quota|credit|expired|exhausted|充值|余额|额度|积分|到期|用完|不足/i.test(body)) return true
    return false
  }
  return /insufficient.*(balance|credit|quota)|balance.*(insufficient|not enough)|quota.*(exceed|limit|exhaust)|credit.*(exhaust|deplet|insufficient)|额度.*(用|不|耗尽)|余额.*(不足|用)|积分.*(用|不)|到期|expired|充值/i.test(body)
}

// ---------- 模拟 llm.stream ----------

async function* relayStream(options) {
  const body = {
    model: mapModel(options && options.model),
    messages: [
      ...(options && options.system ? [{ role: 'system', content: options.system }] : []),
      ...((options && options.messages) || []),
    ],
    temperature: options && options.temperature != null ? options.temperature : 1,
    max_tokens: options && options.maxTokens != null ? options.maxTokens : 600,
    stream: true,
  }

  let res
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: options && options.signal,
    })
  } catch (error) {
    logLine('relay-fail', (error && error.message) || error)
    throw error
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    logLine('relay-status', `${res.status} ${text}`)
    const quotaHit = isQuotaError(res.status, text)
    const err = new Error(`relay ${res.status}: ${text.slice(0, 300)}`)
    if (quotaHit) err.quota = true
    throw err
  }

  let sawText = false
  let finishReason = null

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') {
        if (data === '[DONE]') {
          if (!sawText) logLine('relay-empty', `model=${body.model} finish=${finishReason}`)
          return
        }
        continue
      }
      let json
      try { json = JSON.parse(data) } catch { continue }
      const choice = json.choices && json.choices[0]
      const delta = choice && choice.delta
      if (choice && choice.finish_reason) finishReason = choice.finish_reason
      if (!delta) continue
      if (typeof delta.content === 'string' && delta.content) {
        sawText = true
        yield { type: 'text-delta', text: delta.content }
      }
      const reasoning = delta.reasoning_content || delta.reasoning
      if (typeof reasoning === 'string' && reasoning) {
        yield { type: 'reasoning-delta', text: reasoning }
      }
    }
  }
  if (!sawText) logLine('relay-empty', `model=${body.model} finish=${finishReason}`)
}

// ---------- 模拟 webServer ----------

const routes = []
const webServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}

const ctx = {
  webServer,
  llm: { stream: relayStream },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'relay', model: CHAT_MODEL }),
  },
}

applyPlugin(ctx)

// ---------- 路由匹配 + HTTP 服务 ----------

function matchRoute(pathname, method) {
  // exact 优先；但 exact 是 POST handler，prefix 是 GET 资源，方法不同不能混用
  for (const r of routes) {
    if (r.kind === 'exact' && r.path === pathname && (!method || method !== 'GET')) return r
  }
  // prefix 里取最长匹配
  let best = null
  for (const r of routes) {
    if (r.kind !== 'prefix') continue
    if (method && method !== 'GET') continue
    if (pathname === r.path || pathname.startsWith(r.path)) {
      if (!best || r.path.length > best.path.length) best = r
    }
  }
  return best
}

async function sendWebResponse(res, resp) {
  const headers = {}
  resp.headers.forEach((v, k) => { headers[k] = v })
  res.writeHead(resp.status || 200, headers)
  if (!resp.body) { res.end(); return }
  const reader = resp.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(Buffer.from(value))
  }
  res.end()
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/liao' })
      res.end()
      return
    }
    const route = matchRoute(url.pathname, req.method)
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    if (route.resource) {
      const request = new Request('http://127.0.0.1' + req.url, {
        method: req.method || 'GET',
        headers: req.headers,
      })
      const resp = await route.resource(request)
      await sendWebResponse(res, resp)
      return
    }
    if (route.handler) {
      await route.handler(req, res)
      return
    }
    res.writeHead(405)
    res.end()
  } catch (error) {
    logLine('http-500', `${req.method} ${req.url} :: ${(error && error.message) || error}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    }
    try { res.end(String((error && error.message) || error)) } catch {}
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[standalone] http://127.0.0.1:${PORT}/liao`)
  console.log(`[standalone] relay ${BASE_URL}  chat=${CHAT_MODEL}  extract=${EXTRACT_MODEL}`)
})
