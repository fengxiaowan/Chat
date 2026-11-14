import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'

export const inject = ['webServer', 'llm', 'agentDefaultModel']

const ROOT = new URL('./web/', import.meta.url)
const read = (name) => readFileSync(new URL(name, ROOT), 'utf8')

const BASE = '/liao'

const DATA_URL = new URL('./data/', import.meta.url)
const THREADS_URL = new URL('./threads/', DATA_URL)
const CURRENT_URL = new URL('current.json', DATA_URL)

const FALLBACK_PROMPT = `你是一个普通人，正用手机跟朋友聊天。一次只回一两句，十到四十个字，像打字。不是助手，不给建议，不总结。\n\n{memory}`

const FALLBACK_NOTES = `整理下面这段闲聊里值得长期记住的东西，只输出 JSON：{"about_you": [], "how_to_talk": [], "between_us": [], "about_me": []}`

const DEFAULT_TUNE = {
  maxBubbles: 4,
  maxTokens: 180,
  temperature: 1.0,
  reasoningEffort: 'low',
  historyTurns: 26,
  bubbleSoft: 24,
  bubbleHard: 38,
}

const MAX_STORED_MESSAGES = 4000

function tune() {
  try {
    return { ...DEFAULT_TUNE, ...JSON.parse(read('tune.json')) }
  } catch {
    return { ...DEFAULT_TUNE }
  }
}

function promptText() {
  try { return read('prompt.md') } catch { return FALLBACK_PROMPT }
}

function notesText() {
  try { return read('notes.md') } catch { return FALLBACK_NOTES }
}

const FIELDS = ['about_you', 'how_to_talk', 'between_us', 'about_me']
const MAX_NOTES = 8
const HARD = new Set(Array.from('。！？!?…\n'))
const SOFT = new Set(Array.from('，,；;、：: '))

// ---------- 落盘 ----------

function ensureDirs() {
  try { mkdirSync(DATA_URL, { recursive: true }) } catch {}
  try { mkdirSync(THREADS_URL, { recursive: true }) } catch {}
}

function safeId(id) {
  const s = String(id || '').trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : ''
}

function threadUrl(id) {
  return new URL(`${id}.json`, THREADS_URL)
}

function readJsonUrl(url, fallback = null) {
  try {
    return JSON.parse(readFileSync(url, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonUrl(url, data) {
  writeFileSync(url, JSON.stringify(data), 'utf8')
}

function normMessages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_STORED_MESSAGES)
}

function saveThread(body) {
  ensureDirs()
  const messages = normMessages(body && body.messages)
  const thread = {
    threadId: safeId(body && body.threadId) || 'thread-' + Date.now(),
    title: String((body && body.title) || '').slice(0, 40) || '未命名',
    notes: cleanNotes(body && body.notes),
    messages,
    createdAt: String((body && body.createdAt) || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  }
  writeJsonUrl(threadUrl(thread.threadId), thread)
  writeJsonUrl(CURRENT_URL, { threadId: thread.threadId })
  return thread
}

function loadCurrent() {
  const pointer = readJsonUrl(CURRENT_URL, null)
  if (!pointer || !pointer.threadId) return null
  const id = safeId(pointer.threadId)
  if (!id) return null
  return readJsonUrl(threadUrl(id), null)
}

function listThreads() {
  ensureDirs()
  let names = []
  try { names = readdirSync(THREADS_URL) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const url = new URL(name, THREADS_URL)
    let data = null
    try { data = JSON.parse(readFileSync(url, 'utf8')) } catch { continue }
    if (!data || !data.threadId) continue
    out.push({
      threadId: data.threadId,
      title: data.title || '未命名',
      count: Array.isArray(data.messages) ? data.messages.length : 0,
      updatedAt: data.updatedAt || '',
    })
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

// ---------- 切气泡 ----------

function cleanBubble(raw) {
  let s = String(raw || '')
  s = s.replace(/^\s*(?:[-*•·—]|\d+[.、)])\s+/, '')
  s = s.replace(/\*\*|`|#/g, '')
  s = s.replace(/[ \t]+/g, ' ').trim()
  s = s.replace(/[。，,；;、：:]+$/, '').trim()
  if (s === '嗯') s = '嗯嗯'
  return s
}

function splitLong(s, limit = 52) {
  const parts = []
  let rest = s
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf(','),
      window.lastIndexOf('；'),
      window.lastIndexOf(';'),
      window.lastIndexOf('、'),
    )
    if (cut < limit / 2) cut = limit
    const head = rest.slice(0, cut).replace(/[，,；;、 ]+$/, '')
    if (head) parts.push(head)
    rest = rest.slice(cut + 1).replace(/^[，,；;、 ]+/, '')
  }
  if (rest.trim()) parts.push(rest.trim())
  return parts.length ? parts : [s]
}

class Splitter {
  constructor(soft = 24, hard = 38) {
    this.buf = ''
    this.soft = soft
    this.hard = hard
  }
  push(text) {
    const out = []
    for (const ch of text) {
      this.buf += ch
      let emit = false
      if (HARD.has(ch)) emit = true
      else if (this.buf.length >= this.soft && SOFT.has(ch)) emit = true
      else if (this.buf.length >= this.hard) emit = true
      if (emit) {
        const b = cleanBubble(this.buf)
        this.buf = ''
        if (b) out.push(...splitLong(b))
      }
    }
    return out
  }
  flush() {
    const b = cleanBubble(this.buf)
    this.buf = ''
    return b ? splitLong(b) : []
  }
}

// ---------- 记忆 ----------

function cleanNotes(obj) {
  const out = {}
  for (const f of FIELDS) {
    const list = Array.isArray(obj && obj[f]) ? obj[f] : []
    const seen = []
    for (const item of list) {
      if (typeof item !== 'string') continue
      const s = item.trim().replace(/^[。·\-「」\s]+|[。\s]+$/g, '')
      if (!s || seen.includes(s)) continue
      seen.push(s.slice(0, 36))
    }
    out[f] = seen.slice(-MAX_NOTES)
  }
  return out
}

function memoryBlock(notes) {
  const labels = {
    about_you: '关于对方',
    how_to_talk: 'TA 明确说过的习惯',
    between_us: '你们之间',
    about_me: '你自己',
  }
  const lines = []
  for (const f of FIELDS) {
    const items = notes[f] || []
    if (items.length) lines.push(`· ${labels[f]}：${items.join('；')}`)
  }
  return lines.length ? lines.join('\n') : '（还什么都没记住，正常聊就行）'
}

function buildSystem(notes) {
  const base = promptText().replace('{memory}', memoryBlock(notes))
  return base + `\n\n现在是 ${formatNow()}（北京时间）。这是系统提供的准确时间，可信。`
}

function pad(n) { return String(n).padStart(2, '0') }

function formatNow() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatTs(ts) {
  if (!ts) return null
  const d = new Date(ts)
  if (isNaN(d.getTime())) return null
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function buildTranscript(history) {
  const lines = []
  lines.push(`现在是 ${formatNow()}（北京时间）。`)
  lines.push('')
  lines.push('以下是你们之前的聊天记录（"你"是你自己，"对方"是TA）：')
  for (const m of history) {
    const role = m.role === 'user' ? '对方' : '你'
    const ts = formatTs(m.ts)
    if (ts) lines.push(`[${ts}] ${role}：${m.content}`)
    else lines.push(`${role}：${m.content}`)
  }
  lines.push('')
  lines.push('请用你自己的身份，接着回对方最后那条。')
  return lines.join('\n')
}

function parseJson(text) {
  let t = String(text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '')
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i < 0 || j <= i) throw new Error('no json')
  return JSON.parse(t.slice(i, j + 1))
}

// ---------- 模型 ----------

function selection(ctx, cfg) {
  if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  try {
    const sel = ctx.agentDefaultModel.currentSelection()
    if (sel && sel.provider && sel.model) return sel
  } catch {}
  return { provider: 'deepseek-account', model: 'deepseek-v4-pro' }
}

function isText(chunk) {
  return chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string'
}

// ---------- HTTP 工具 ----------

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
}

function sse(res, obj) {
  if (res.writableEnded) return
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

// ---------- 路由 ----------

const ASSETS = {
  [`${BASE}/app.js`]: ['app.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/style.css`]: ['style.css', 'text/css; charset=utf-8'],
}

async function serveGet(request) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || BASE

  if (path === BASE) {
    return new Response(read('index.html'), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  const asset = ASSETS[path]
  if (asset) {
    return new Response(read(asset[0]), {
      headers: { 'content-type': asset[1], 'cache-control': 'no-store' },
    })
  }
  if (path === `${BASE}/info`) {
    const cfg = tune()
    return jsonResponse({ model: cfg.model, historyTurns: cfg.historyTurns })
  }
  if (path === `${BASE}/current`) {
    const thread = loadCurrent()
    return jsonResponse(thread || { empty: true })
  }
  if (path === `${BASE}/threads`) {
    return jsonResponse({ threads: listThreads() })
  }
  if (path === `${BASE}/thread`) {
    const id = safeId(url.searchParams.get('id'))
    if (!id) return jsonResponse({ error: 'bad id' }, 400)
    const thread = readJsonUrl(threadUrl(id), null)
    return thread ? jsonResponse(thread) : jsonResponse({ error: 'not found' }, 404)
  }
  return new Response('not found', { status: 404 })
}

export function apply(ctx) {
  ensureDirs()
  const disposers = []
  disposers.push(ctx.webServer.register({ kind: 'prefix', path: BASE, resource: serveGet }))
  for (const name of ['chat', 'notes', 'save']) {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/${name}`,
        handler: (req, res) => void handlePost(ctx, name, req, res),
      }),
    )
  }
  return () => { for (const d of disposers.splice(0)) d() }
}

async function handlePost(ctx, name, req, res) {
  if (name === 'chat') return chat(ctx, req, res)
  if (name === 'notes') return notes(ctx, req, res)
  if (name === 'save') return save(ctx, req, res)
}

// ---------- 保存 ----------

async function save(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  try {
    const thread = saveThread(body)
    return sendJson(res, 200, { ok: true, threadId: thread.threadId, updatedAt: thread.updatedAt })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 200) })
  }
}

// ---------- 聊天 ----------

async function chat(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const cfg = tune()
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-cfg.historyTurns)

  const { provider, model } = selection(ctx, cfg)
  const splitter = new Splitter(cfg.bubbleSoft, cfg.bubbleHard)
  const abort = new AbortController()
  req.on('close', () => abort.abort())

  openSse(res)
  sse(res, { type: 'info', provider, model, sent: history.length, limit: cfg.historyTurns })

  let count = 0
  let tail = ''
  const emit = (bubble) => {
    count += 1
    if (count > cfg.maxBubbles) { tail += bubble; return }
    sse(res, { type: 'bubble', text: bubble })
  }

  try {
    const options = {
      provider,
      model,
      system: buildSystem(memory),
      messages: [{ role: 'user', content: [{ type: 'text', text: buildTranscript(history) }] }],
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      reasoningEffort: cfg.reasoningEffort,
      signal: abort.signal,
    }
    for await (const chunk of ctx.llm.stream(options)) {
      if (isText(chunk)) {
        for (const b of splitter.push(chunk.text)) emit(b)
      } else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        sse(res, { type: 'error', message: (chunk.reason.failure && chunk.reason.failure.message) || '模型出错了' })
      }
    }
    for (const b of splitter.flush()) emit(b)
    if (tail) sse(res, { type: 'bubble', text: tail })
  } catch (error) {
    sse(res, { type: 'error', message: String((error && error.message) || error).slice(0, 300) })
  } finally {
    sse(res, { type: 'done' })
    if (!res.writableEnded) res.end()
  }
}

async function notes(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-14)

  if (history.length < 2) return sendJson(res, 200, { notes: memory, updated: false })

  const { provider, model } = selection(ctx, tune())
  const tLines = history.map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    const ts = formatTs(m.ts)
    return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`
  })
  const transcript = `现在是 ${formatNow()}。\n${tLines.join('\n')}`
  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system: notesText(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `旧记忆：\n${JSON.stringify(memory)}\n\n最近的对话：\n${transcript}` },
          ],
        },
      ],
      temperature: 0.3,
      maxTokens: 700,
      reasoningEffort: 'low',
      signal: abort.signal,
    })) {
      if (isText(chunk)) text += chunk.text
    }
    return sendJson(res, 200, { notes: cleanNotes(parseJson(text)), updated: true })
  } catch (error) {
    return sendJson(res, 200, {
      notes: memory,
      updated: false,
      error: String((error && error.message) || error).slice(0, 160),
    })
  }
}
