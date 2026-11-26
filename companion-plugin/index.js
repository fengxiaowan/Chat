import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer', 'llm', 'agentDefaultModel']

const ROOT = new URL('./web/', import.meta.url)
const read = (name) => readFileSync(new URL(name, ROOT), 'utf8')

const BASE = '/liao'

const DATA_URL = new URL('./data/', import.meta.url)
const THREADS_URL = new URL('./threads/', DATA_URL)
const CURRENT_URL = new URL('current.json', DATA_URL)
const MEMORY_URL = new URL('./memory/', DATA_URL)
const EPISODES_URL = new URL('episodes.json', MEMORY_URL)
const STATE_URL = new URL('state.json', MEMORY_URL)
const FACTS_URL = new URL('facts.json', MEMORY_URL)
const DIGEST_URL = new URL('digest.json', MEMORY_URL)
const IMAGES_URL = new URL('./images/', DATA_URL)
const TTS_URL = new URL('./tts/', DATA_URL)
const MEMOS_URL = new URL('./memos/', DATA_URL)
const DRAWINGS_URL = new URL('./drawings/', DATA_URL)
const ALBUMS_URL = new URL('./albums/', DATA_URL)
const CHAT_BG_URL = new URL('chat-background.json', DATA_URL)
// 同一句语音可能同时被预取和播放请求命中。把生成任务合并，避免
// 蜂窝网络抖动时重复启动 edge-tts，重复任务会互相抢带宽并延迟出声。
const TTS_INFLIGHT = new Map()
const PYTHON = 'C:\\Users\\lyy44\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
const TTS_VOICE = 'zh-CN-XiaoxiaoNeural'

const FALLBACK_PROMPT = `你是一个普通人，正用手机跟朋友聊天。一次只回一两句，十到四十个字，像打字。不是助手，不给建议，不总结。\n\n{memory}\n\n【人称不能错】你说话时「我」永远是你自己，「你」永远指对方。写长句时尤其要核对：这句里的「我」是不是你、「你」是不是对方。\n\n【怎么接话】\n· 对方说"复杂""说不清""以后再说""先这样"——这就是不想展开了，那就别再问。\n· 一个话题你问过、对方没正面回答，就不要再问第二遍。追问会让人语塞。\n· 你发出的几句话要方向一致。刚答应"边聊边看"，就别紧跟着又追问细节。\n· 不用每句都凑满。想不出说什么，一两句短的就行。\n\n【什么时候闭嘴】\n· 对方累、烦、情绪低落，先顺着，别出主意，别推进任何计划。\n· 对方想结束某个话题，立刻松手，不解释、不找补。`

const FALLBACK_NOTES = `整理下面这段闲聊里值得长期记住的东西，只输出 JSON：{"about_you": [], "how_to_talk": [], "between_us": [], "about_me": []}`

const FALLBACK_EPISODES = `你在帮一个女孩整理她的记忆。下面是「她」和「对方」的一段聊天记录。

把这段聊天压缩成几条"事件卡"，只输出 JSON 数组，不要别的字：
[{"theme":"","content":"","mood":"","status":"","keywords":[]}]

字段要求：
- theme：一句话概括，12 字以内
- content：**用她自己的第一人称口吻写**，像她自己在回想这件事。
  不要写"对方说…她回应…"这种旁白，要写"他跟我说…我跟他说…"。
  25~50 字。**必须交代清楚谁先谁后、因为什么所以什么**，别只罗列。
- mood：当时的气氛或心情，几个字
- status：这件事的状态，只能是这三个之一：
  - "done" 已经真的发生了（做过的事、去过的地方、聊定的事）
  - "plan" 只是提过、说要做、还没真做
  - "idea" 随口一想、明确了"以后再说"的
- keywords：3~5 个能被下次搜到的词（人名、地名、物品名、专有名词）

特别注意：
- 如果同一件事先"说要做"、后来"真的做了"，就合并成一条，status 写 "done"，content 里体现"后来真的做了"。
- 不要为寒暄、附和单独建卡。
- 一次输出 2~5 条，宁少勿滥。`

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

// 把补丁写回 web/tune.json（先写临时文件再改名，避免写坏）
function writeTune(patch) {
  const target = new URL('tune.json', ROOT)
  const tmp = new URL('tune.json.tmp', ROOT)
  let cur = {}
  try { cur = JSON.parse(readFileSync(target, 'utf8')) } catch {}
  const next = { ...cur, ...patch }
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, target)
}

function promptText() {
  try { return read('prompt.md') } catch { return FALLBACK_PROMPT }
}

function notesText() {
  try { return read('notes.md') } catch { return FALLBACK_NOTES }
}

// ---------- 访问密码 ----------

function authPassword() {
  try {
    const cfg = tune()
    return (cfg && cfg.password) ? String(cfg.password) : ''
  } catch { return '' }
}

// 记住登录用的 cookie 值（密码变了自动失效）
function authCookie() {
  const pw = authPassword()
  try { return createHash('sha256').update('companion-auth:' + pw).digest('hex') } catch { return '' }
}

function headerValue(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return String(headers.get(name) || '')
  return String(headers[name] || '')
}

function checkAuth(headers) {
  const pw = authPassword()
  if (!pw) return true
  const cookie = headerValue(headers, 'cookie')
  const want = authCookie()
  if (want && cookie.includes('companion_auth=' + want)) return true
  const authHeader = headerValue(headers, 'authorization')
  if (!authHeader.startsWith('Basic ')) return false
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const idx = decoded.indexOf(':')
    return idx >= 0 && decoded.slice(idx + 1) === pw
  } catch { return false }
}

// Response 的 body 只能被读一次：401 必须每次新建。
// 复用同一个对象时，第二次未鉴权请求会拿到已锁定的流（standalone 端报 ReadableStream is locked）。
function unauthResponse() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="companion"', 'content-type': 'text/plain; charset=utf-8' },
  })
}

function episodesText() {
  try { return read('episodes.md') } catch { return FALLBACK_EPISODES }
}

const FIELDS = ['about_you', 'how_to_talk', 'between_us', 'about_me']
const MAX_NOTES = 8
// 分层记忆 / 事件卡参数
const EPISODE_BATCH = 30        // 每累计约 15 轮(30 条)消息，才批量压一次事件卡（提高门槛）
const EPISODE_WINDOW = 40       // 每段（每次 LLM 调用）压缩的消息条数
const EPISODE_BACKFILL_MAX = 30 // 单次后台最多压多少段，防历史太长一次跑不完
const MAX_EPISODES = 100        // L1 近期事件卡上限，超了向下沉降到 L2
const EPISODE_SINK_DAYS = 60    // 超过 60 天的卡向下沉降
const WEEKLY_MAX = 120          // L2 周归纳上限，超龄再沉到 L3
const RECALL_K = 5             // 每轮主动回忆最多注入几条
const RECALL_THRESHOLD = 0.28  // 相关分低于此值就不注入，省 token
// 新鲜度衰减：2 个月线性衰减，别让「昨天的一句错话」压过「上周的正确记忆」。
const RECALL_DECAY_DAYS = 60
const MAX_SUMMARY = 160        // 滚动摘要最长字符
const HARD = new Set(Array.from('。！？!?\n'))
const SOFT = new Set(Array.from('，,；;、：:'))
// 成对引号：开、闭一一对应。切气泡时不能把一对引号从中间劈开。
// 含全角弯引号、直角引号「」、半角引号。
const QUOTE_PAIRS = [['“', '”'], ['‘', '’'], ['「', '」'], ['"', '"'], ["'", "'"]]

// 判断从字符串开头到 pos 处，是否还有未闭合的开引号（即 pos 落在引号内部）。
function insideQuote(s, pos) {
  const head = s.slice(0, pos)
  for (const [open, close] of QUOTE_PAIRS) {
    if (open === close) {
      // 半角引号开闭同形，成对出现；奇数个 = 未闭合
      const n = (head.match(new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
      if (n % 2 === 1) return true
    } else {
      let depth = 0
      for (const ch of head) {
        if (ch === open) depth++
        else if (ch === close && depth > 0) depth--
      }
      if (depth > 0) return true
    }
  }
  return false
}

// 给定一个切点，若它落在引号内部，则往前回退到那个未闭合引号之前，返回安全切点。
// 若回退后太靠前（小于一半），就放弃回退、返回原切点（宁可硬切也不切出一堆碎渣）。
function backOffQuote(s, cutAt, minLen) {
  if (!insideQuote(s, cutAt)) return cutAt
  // 从 cutAt 往前找最近的未闭合引号位置
  for (let i = cutAt - 1; i >= 0; i--) {
    const ch = s[i]
    for (const [open, close] of QUOTE_PAIRS) {
      if (ch === open) {
        if (open === close) {
          const n = (s.slice(0, i).match(new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
          if (n % 2 === 0) return i  // 这个 open 是导致未闭合的那个
        } else {
          // 检查 i 处是否是这个 pair 里导致未闭合的 open
          let depth = 0
          for (let k = 0; k <= i; k++) {
            if (s[k] === open) depth++
            else if (s[k] === close && depth > 0) depth--
          }
          if (depth === 1 && i >= minLen) return i
        }
      }
    }
  }
  return cutAt
}

// ---------- 落盘 ----------

function ensureDirs() {
  try { mkdirSync(DATA_URL, { recursive: true }) } catch {}
  try { mkdirSync(THREADS_URL, { recursive: true }) } catch {}
  try { mkdirSync(MEMOS_URL, { recursive: true }) } catch {}
  try { mkdirSync(DRAWINGS_URL, { recursive: true }) } catch {}
  try { mkdirSync(ALBUMS_URL, { recursive: true }) } catch {}
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

// ---------- 便签纸 ----------

function memoUrl(id) {
  return new URL(`${id}.json`, MEMOS_URL)
}

function listMemos() {
  ensureDirs()
  let names = []
  try { names = readdirSync(MEMOS_URL) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const data = readJsonUrl(new URL(name, MEMOS_URL), null)
    if (!data || !data.id) continue
    out.push({
      id: data.id,
      title: String(data.title || '').slice(0, 6) || '未命名',
      content: String(data.content || ''),
      createdAt: data.createdAt || '',
      updatedAt: data.updatedAt || '',
    })
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

function readMemo(id) {
  return readJsonUrl(memoUrl(id), null)
}

async function memoPost(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const action = String(body && body.action || 'save')
  if (action === 'delete') {
    const id = safeId(body && body.id)
    if (!id) return sendJson(res, 400, { error: 'bad id' })
    try {
      rmSync(memoUrl(id), { force: true })
      return sendJson(res, 200, { ok: true, id })
    } catch (error) {
      return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
    }
  }
  if (action === 'rename') {
    const id = safeId(body && body.id)
    if (!id) return sendJson(res, 400, { error: 'bad id' })
    const existing = readMemo(id)
    if (!existing) return sendJson(res, 404, { error: 'memo not found' })
    const title = String(body && body.title || '').trim().slice(0, 6) || '未命名'
    const memo = { ...existing, title, updatedAt: new Date().toISOString() }
    writeJsonUrl(memoUrl(id), memo)
    return sendJson(res, 200, { ok: true, memo })
  }
  if (action !== 'save') return sendJson(res, 400, { error: 'bad action' })

  ensureDirs()
  const id = safeId(body && body.id) || 'memo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  const existing = readMemo(id)
  const content = String(body && body.content || '').slice(0, 200000)
  const title = String(body && body.title || (existing && existing.title) || '').slice(0, 6) || '未命名'
  // 作者记录：这次保存是谁写的（user=对方，assistant=她），用于让她知道纸的来龙去脉，但不显示在纸上
  const author = body && body.author === 'assistant' ? 'assistant' : 'user'
  const oldContent = (existing && typeof existing.content === 'string') ? existing.content : ''
  const prevEvents = (existing && Array.isArray(existing.events)) ? existing.events : []
  let delta = ''
  let edited = false
  if (oldContent && content.startsWith(oldContent)) {
    // 纯追加：delta 就是这次新写上去的部分
    delta = content.slice(oldContent.length)
  } else if (oldContent) {
    // 不是纯追加（中间改动或删减）：无法精确归属，记录一次「修改」
    edited = true
  } else {
    delta = content
  }
  const events = prevEvents.slice(-200)
  if (edited || delta.trim()) {
    events.push({ author, text: delta.trim().slice(0, 2000), edited: !!edited, at: new Date().toISOString() })
  }
  const memo = {
    id,
    title,
    content,
    events,
    createdAt: String((body && body.createdAt) || (existing && existing.createdAt) || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  }
  writeJsonUrl(memoUrl(id), memo)
  return sendJson(res, 200, { ok: true, memo })
}

// 她写纸上：独立接口，严格 JSON 输出续写内容，不再依赖聊天里的魔法标记。
async function memoWrite(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const id = safeId(body && body.id)
  if (!id) return sendJson(res, 400, { error: 'bad id' })
  const existing = readMemo(id)
  if (!existing) return sendJson(res, 404, { error: 'memo not found' })
  const instruction = String(body && body.instruction || '').trim().slice(0, 500)
  const cfg = tune()
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-cfg.historyTurns)
  const { provider, model } = selection(ctx, cfg)
  const events = Array.isArray(existing.events) ? existing.events.slice(-30) : []
  const eventText = events.map((e) => {
    const who = e.author === 'assistant' ? '你自己（我）' : '对方'
    return `${who}写了：${String(e.text || '').trim().slice(0, 300)}`
  }).join('\n')
  const currentText = String(existing.content || '').trim().slice(0, 12000)

  const system = promptText().replace('{memory}', memoryBlock(memory)) +
    `\n\n你和朋友正在共同写一张便签纸。你现在要往纸上续写一段。\n\n【这张纸的来龙去脉】\n${eventText || '（这张纸还没有内容）'}\n\n【当前纸上全文】\n${currentText || '（空白）'}\n\n【续写要求】\n· 接着纸上的内容往下写，用你自己的口吻，短句，别写成范文，别总结，别用「然而」「仿佛」。\n· 只写一小段（一两句），写不动就写到这句为止。\n· 你写的是新内容，绝不能复述、重复或抄写纸上已有的任何文字。\n· 如果对方明确说了想写什么方向，就顺着那个方向。\n\n只输出你要写到纸上的那段文字，不要引号、不要任何前缀、不要解释。`

  const recent = history.slice(-12).map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    return `${role}：${m.content}`
  }).join('\n')
  const userContent = [{ type: 'text', text: `对方说：${instruction || '（没具体说，你顺着往下写）'}\n\n最近聊天：\n${recent}` }]

  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.8,
      maxTokens: 300,
      reasoningEffort: 'low',
      signal: abort.signal,
    })) {
      if (isText(chunk)) text += chunk.text
    }
    const written = text.replace(/^["'「」\s]+|["'「」\s]+$/g, '').trim().slice(0, 4000)
    if (!written) return sendJson(res, 200, { written: '' })
    const merged = currentText ? currentText.replace(/\s+$/, '') + '\n\n' + written : written
    const events2 = events.concat([{ author: 'assistant', text: written, edited: false, at: new Date().toISOString() }]).slice(-200)
    const memo = {
      ...existing,
      content: merged,
      title: String(existing.title || '').slice(0, 6) || '未命名',
      events: events2,
      updatedAt: new Date().toISOString(),
    }
    writeJsonUrl(memoUrl(id), memo)
    return sendJson(res, 200, { written, memo })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
  }
}

// ---------- 画板 ----------

function drawingUrl(id) {
  return new URL(`${id}.json`, DRAWINGS_URL)
}

function loadDrawing(id) {
  const d = readJsonUrl(drawingUrl(id), null)
  if (d && typeof d === 'object') {
    return {
      id: String(d.id || id),
      title: typeof d.title === 'string' ? d.title : '',
      strokes: Array.isArray(d.strokes) ? d.strokes : [],
      createdAt: typeof d.createdAt === 'string' ? d.createdAt : '',
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
    }
  }
  return null
}

function listDrawings() {
  ensureDirs()
  let names = []
  try { names = readdirSync(DRAWINGS_URL) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const d = readJsonUrl(new URL(name, DRAWINGS_URL), null)
    if (!d || !d.id) continue
    out.push({
      id: d.id,
      title: typeof d.title === 'string' ? d.title : '',
      strokes: Array.isArray(d.strokes) ? d.strokes.length : 0,
      createdAt: d.createdAt || '',
      updatedAt: d.updatedAt || '',
    })
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

// 把她给的图形指令转成带手抖的笔迹（她决定画什么，引擎保证画得出来）
function shapeToStroke(shape) {
  // 图形库：circle / line / dot / triangle / flower
  const kind = String(shape && shape.kind || 'circle')
  const cx = Number(shape && shape.x) || 0.5
  const cy = Number(shape && shape.y) || 0.5
  const r = Math.min(0.4, Math.max(0.03, Number(shape && shape.r) || 0.15))
  const jitter = (p, amp) => p + (Math.random() - 0.5) * amp
  const pts = []
  const N = 36
  if (kind === 'circle') {
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2
      pts.push([jitter(cx + Math.cos(a) * r, 0.012), jitter(cy + Math.sin(a) * r, 0.012)])
    }
  } else if (kind === 'line') {
    const x2 = Number(shape.x2) || (cx + r)
    const y2 = Number(shape.y2) || cy
    for (let i = 0; i <= 12; i++) {
      const t = i / 12
      pts.push([jitter(cx + (x2 - cx) * t, 0.008), jitter(cy + (y2 - cy) * t, 0.008)])
    }
  } else if (kind === 'dot') {
    pts.push([cx, cy])
  } else if (kind === 'triangle') {
    const corners = [
      [cx, cy - r],
      [cx + r * 0.9, cy + r * 0.7],
      [cx - r * 0.9, cy + r * 0.7],
    ]
    corners.forEach(([x, y]) => pts.push([x, y]))
    pts.push(corners[0])
  } else if (kind === 'flower') {
    for (let p = 0; p < 6; p++) {
      const a = (p / 6) * Math.PI * 2
      pts.push([jitter(cx + Math.cos(a) * r, 0.01), jitter(cy + Math.sin(a) * r, 0.01)])
      pts.push([cx, cy])
    }
  }
  return {
    kind: 'shape',
    shape: kind,
    points: pts,
    color: '#6f9ed9',
    size: 3,
    author: 'assistant',
    ts: Date.now(),
  }
}

// 她画一笔：把画布截图 + 用户指令喂给她，她输出图形指令，后端转笔迹
async function drawAi(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const id = safeId(body && body.id)
  if (!id) return sendJson(res, 400, { error: 'bad id' })
  const existing = loadDrawing(id) || { id, strokes: [], createdAt: new Date().toISOString(), updatedAt: '' }
  const instruction = String(body && body.instruction || '').trim().slice(0, 500)
  const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : ''
  const cfg = tune()
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-cfg.historyTurns)
  const { provider, model } = selection(ctx, cfg)

  const system = promptText().replace('{memory}', memoryBlock(memory)) +
    `\n\n你和朋友正在共用一张画板。对方可能画了一些东西，现在轮到你画一笔。\n\n你只能画这些简单图形之一：circle（圆）、line（直线）、dot（点）、triangle（三角形）、flower（花）。\n\n画布坐标都是 0~1：x 从左到右，y 从上到下。\n\n只输出一个 JSON 对象，不要任何其他文字：\n{"say":"用你自己的口吻说一句正在画什么","shape":{"kind":"circle","x":0.5,"y":0.5,"r":0.15}}\n其中 line 需要 x2、y2；其他图形只要 x、y、r。say 是 8~20 个字。`

  const recent = history.slice(-12).map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    return `${role}：${m.content}`
  }).join('\n')
  const userContent = [{ type: 'text', text: `对方说：${instruction || '（没具体说，你顺着画）'}\n\n最近聊天：\n${recent}` }]
  if (image) userContent.push({ type: 'image_url', image_url: { url: image } })

  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.7,
      maxTokens: 120,
      reasoningEffort: 'low',
      signal: abort.signal,
    })) {
      if (isText(chunk)) text += chunk.text
    }
    let say = ''
    let shape = null
    try {
      const obj = parseJson(text)
      if (typeof obj.say === 'string') say = obj.say.trim().slice(0, 60)
      if (obj.shape && typeof obj.shape.kind === 'string') shape = obj.shape
    } catch {}
    if (!shape) shape = { kind: 'dot', x: 0.5, y: 0.5, r: 0.08 }
    const stroke = shapeToStroke(shape)
    const strokes = existing.strokes.concat([stroke]).slice(-2000)
    const drawing = { ...existing, strokes, updatedAt: new Date().toISOString() }
    writeJsonUrl(drawingUrl(id), drawing)
    return sendJson(res, 200, { stroke, say, drawing })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
  }
}

async function drawingPost(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const action = String(body && body.action || 'save')
  if (action === 'delete') {
    const id = safeId(body && body.id)
    if (!id) return sendJson(res, 400, { error: 'bad id' })
    try {
      rmSync(drawingUrl(id), { force: true })
      return sendJson(res, 200, { ok: true, id })
    } catch (error) {
      return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
    }
  }
  if (action === 'rename') {
    const id = safeId(body && body.id)
    if (!id) return sendJson(res, 400, { error: 'bad id' })
    const existing = loadDrawing(id)
    if (!existing) return sendJson(res, 404, { error: 'drawing not found' })
    const title = String(body && body.title || '').trim().slice(0, 12) || '未命名'
    const drawing = { ...existing, title, updatedAt: new Date().toISOString() }
    writeJsonUrl(drawingUrl(id), drawing)
    return sendJson(res, 200, { ok: true, drawing })
  }
  if (action !== 'save') return sendJson(res, 400, { error: 'bad action' })
  ensureDirs()
  const id = safeId(body && body.id) || 'draw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  const existing = loadDrawing(id)
  const strokes = Array.isArray(body && body.strokes) ? body.strokes.slice(0, 2000) : (existing ? existing.strokes : [])
  const title = typeof body && typeof body.title === 'string' ? body.title.trim().slice(0, 12) : (existing ? existing.title : '')
  const drawing = {
    id,
    title: title || '未命名',
    strokes,
    createdAt: String((body && body.createdAt) || (existing && existing.createdAt) || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  }
  writeJsonUrl(drawingUrl(id), drawing)
  return sendJson(res, 200, { ok: true, drawing })
}

// ---------- 相册：收藏珍贵图片 + 配文，共同回忆 ----------
// 图片复用 images 目录（saveImage/imageFile 的 hash 存储），相册条目只存元数据。

function albumUrl(id) {
  return new URL(`${id}.json`, ALBUMS_URL)
}

function listAlbums() {
  ensureDirs()
  let names = []
  try { names = readdirSync(ALBUMS_URL) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const data = readJsonUrl(new URL(name, ALBUMS_URL), null)
    if (!data || !data.id || !data.hash) continue
    out.push({
      id: data.id,
      hash: data.hash,
      caption: String(data.caption || ''),
      createdAt: data.createdAt || '',
      updatedAt: data.updatedAt || '',
    })
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

async function albumPost(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const action = String(body && body.action || 'save')
  if (action === 'delete') {
    const id = safeId(body && body.id)
    if (!id) return sendJson(res, 400, { error: 'bad id' })
    try {
      rmSync(albumUrl(id), { force: true })
      return sendJson(res, 200, { ok: true, id })
    } catch (error) {
      return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
    }
  }
  if (action === 'edit') {
    const id = safeId(body && body.id)
    if (!id) return sendJson(res, 400, { error: 'bad id' })
    const existing = readJsonUrl(albumUrl(id), null)
    if (!existing) return sendJson(res, 404, { error: 'album not found' })
    const caption = String(body && body.caption || '').trim().slice(0, 2000)
    const album = { ...existing, caption, updatedAt: new Date().toISOString() }
    writeJsonUrl(albumUrl(id), album)
    return sendJson(res, 200, { ok: true, album })
  }
  if (action !== 'save') return sendJson(res, 400, { error: 'bad action' })

  ensureDirs()
  // 图片来源：已是服务器上的 hash，或新传的 base64 dataUrl
  let hash = String(body && body.hash || '').replace(/[^a-f0-9]/gi, '')
  if (!hash && body && typeof body.dataUrl === 'string' && body.dataUrl.startsWith('data:image/')) {
    hash = saveImage(body.dataUrl)
  }
  if (!hash || !imageFile(hash)) return sendJson(res, 400, { error: 'bad image' })

  const id = safeId(body && body.id) || 'album-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  const existing = readJsonUrl(albumUrl(id), null)
  const caption = String(body && body.caption || (existing && existing.caption) || '').trim().slice(0, 2000)
  const album = {
    id,
    hash,
    caption,
    createdAt: String((body && body.createdAt) || (existing && existing.createdAt) || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  }
  writeJsonUrl(albumUrl(id), album)
  return sendJson(res, 200, { ok: true, album })
}

// 聊天背景：上传/清除（图片存 images 目录，记录 hash 供多设备同步）
async function chatBgPost(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const action = String(body && body.action || 'set')
  if (action === 'clear') {
    writeJsonUrl(CHAT_BG_URL, { hash: '' })
    return sendJson(res, 200, { ok: true, hash: '' })
  }
  const url = body && typeof body.image === 'string' ? body.image : ''
  if (!url.startsWith('data:image/')) return sendJson(res, 400, { error: 'bad image' })
  const hash = saveImage(url)
  if (!hash) return sendJson(res, 400, { error: 'save failed' })
  writeJsonUrl(CHAT_BG_URL, { hash })
  return sendJson(res, 200, { ok: true, hash })
}

// 中国象棋：她解释 AI 的下一步，行为和话语一起放
async function xqSay(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const board = String(body && body.board || '').slice(0, 4000)
  const move = String(body && body.move || '').slice(0, 40)
  const check = body && body.check
  const captured = String(body && body.captured || '').slice(0, 12)
  if (!board) return sendJson(res, 400, { error: 'bad params' })

  // 只在有确定事件（吃子/将军）时才让她开口，避免自由棋评瞎说
  const isCapturedSelf = captured && captured.startsWith('self:')
  const isCapturedOther = captured && !isCapturedSelf
  const isCheckSelf = check === 'self'
  const isCheckOther = check === true
  if (!isCapturedSelf && !isCapturedOther && !isCheckSelf && !isCheckOther) {
    return sendJson(res, 200, { say: '' })
  }

  const cfg = tune()
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-cfg.historyTurns)
  const { provider, model } = selection(ctx, cfg)

  let event = ''
  if (isCheckSelf) event = '你刚刚被对方将军了（你的黑方王被将）'
  else if (isCheckOther) event = '你这一步将军了对方（红方的王被将）'
  else if (isCapturedSelf) event = `你的一个${captured.slice(5)}被对方吃掉了`
  else if (isCapturedOther) event = `你这一步吃掉了对方的一个${captured}`

  const system = promptText().replace('{memory}', memoryBlock(memory)) +
    `\n\n你和朋友正在下中国象棋，你执黑，对方执红。刚才这一步发生了一件事：${event}。\n\n你只用你自己的口吻说一句简短的话（8~15 个字）回应这件事。禁止谈别的、禁止点评棋局、禁止编造棋谱和局势。\n\n只输出这一句话，不要引号、不要任何前缀。`

  const recent = history.slice(-12).map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    return `${role}：${m.content}`
  }).join('\n')

  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: `最近聊天：\n${recent}\n\n刚才这件事是：${event}。说一句简短回应。` }] }],
      temperature: 0.7,
      maxTokens: 80,
      reasoningEffort: 'low',
      signal: abort.signal,
    })) {
      if (isText(chunk)) text += chunk.text
    }
    const say = text.replace(/^["'「」\s]+|["'「」\s]+$/g, '').trim().slice(0, 60)
    return sendJson(res, 200, { say })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
  }
}

// 中国象棋终局结算：她用一句话总结结果
async function xqOver(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const winner = ['user', 'assistant', 'draw'].includes(body && body.winner) ? body.winner : 'draw'
  const cfg = tune()
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-cfg.historyTurns)
  const { provider, model } = selection(ctx, cfg)

  const resultText = winner === 'user'
    ? '你输了，对方赢了'
    : winner === 'assistant'
      ? '你赢了，对方输了'
      : '和棋'

  const system = promptText().replace('{memory}', memoryBlock(memory)) +
    `\n\n你们刚下完一局中国象棋。结果是：${resultText}。\n\n你用你自己的口吻说一句收尾的话，自然一点，别念规则、别报结果、别总结。赢了别太得意，输了别嘴硬。\n\n只输出这一句话，不要引号、不要任何前缀。`

  const recent = history.slice(-12).map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    return `${role}：${m.content}`
  }).join('\n')

  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: `最近聊天：\n${recent}\n\n请说一句收尾的话。` }] }],
      temperature: 0.8,
      maxTokens: 80,
      reasoningEffort: 'low',
      signal: abort.signal,
    })) {
      if (isText(chunk)) text += chunk.text
    }
    const say = text.replace(/^["'「」\s]+|["'「」\s]+$/g, '').trim().slice(0, 60)
    return sendJson(res, 200, { say })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
  }
}

function normMessages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_STORED_MESSAGES)
}

// 过滤游戏心声，用于记忆/事件卡，避免棋局细节污染长期记忆；聊天短期上下文保留
function normRealMessages(list) {
  return normMessages(list).filter((m) => !(m && m.meta && m.meta.game))
}

function mergeByKey(existing, incoming) {
  const seen = new Set()
  const out = []
  for (const m of (Array.isArray(existing) ? existing : [])) {
    const key = (m && m.ts || '') + '|' + (m && m.role) + '|' + (m && m.content)
    seen.add(key)
    out.push(m)
  }
  for (const m of (Array.isArray(incoming) ? incoming : [])) {
    const key = (m && m.ts || '') + '|' + (m && m.role) + '|' + (m && m.content)
    if (!seen.has(key)) { seen.add(key); out.push(m) }
  }
  return out
}

// 把聊天里发的图片存成文件，返回 hash（聊天记录里只存 hash）
function saveImage(dataUrl) {
  try {
    const m = String(dataUrl).match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i)
    if (!m) return ''
    const mime = m[1].toLowerCase()
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg'
    const buf = Buffer.from(m[2], 'base64')
    const hash = createHash('sha256').update(String(dataUrl)).digest('hex')
    mkdirSync(IMAGES_URL, { recursive: true })
    writeFileSync(new URL(`${hash}.${ext}`, IMAGES_URL), buf)
    return hash
  } catch { return '' }
}

function imageFile(hash) {
  const h = String(hash || '').replace(/[^a-f0-9]/gi, '')
  if (!/^[a-f0-9]{64}$/i.test(h)) return null
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    try {
      const url = new URL(`${h}.${ext}`, IMAGES_URL)
      if (existsSync(url)) return { url, type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }
    } catch {}
  }
  return null
}

function saveThread(body) {
  ensureDirs()
  // 存档剔除游戏心声：短期接话靠前端会话内 history，长期存档不落棋局细节
  const incoming = normRealMessages(body && body.messages)
  const threadId = safeId(body && body.threadId) || 'thread-' + Date.now()
  const existing = readJsonUrl(threadUrl(threadId), null)
  const existingMessages = (existing && Array.isArray(existing.messages)) ? existing.messages : []
  // 服务器端合并：保留已有 + 追加新消息，后保存的一方不会再覆盖另一方
  const merged = mergeByKey(existingMessages, incoming)
  // 空对话不落盘，避免归档里堆一堆 0 条的
  if (!merged.length) {
    return {
      threadId,
      title: String((body && body.title) || (existing && existing.title) || '').slice(0, 40) || '未命名',
      notes: cleanNotes(body && body.notes),
      messages: [],
      createdAt: String((body && body.createdAt) || (existing && existing.createdAt) || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
    }
  }
  const thread = {
    threadId,
    title: String((body && body.title) || (existing && existing.title) || '').slice(0, 40) || '未命名',
    notes: cleanNotes(body && body.notes),
    messages: merged,
    createdAt: String((body && body.createdAt) || (existing && existing.createdAt) || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  }
  writeJsonUrl(threadUrl(threadId), thread)
  writeJsonUrl(CURRENT_URL, { threadId })
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
    const count = Array.isArray(data.messages) ? data.messages.length : 0
    if (count === 0) continue
    out.push({
      threadId: data.threadId,
      title: data.title || '未命名',
      count,
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
    // 切点若落在引号内部，回退到引号之前，别劈开引号对
    cut = backOffQuote(rest, cut, Math.floor(limit / 2))
    const head = rest.slice(0, cut).replace(/[，,；;、 ]+$/, '')
    if (head) parts.push(head)
    rest = rest.slice(cut).replace(/^[，,；;、 ]+/, '')
  }
  if (rest.trim()) parts.push(rest.trim())
  return parts.length ? parts : [s]
}

class Splitter {
  constructor(soft = 24, hard = 38) {
    this.buf = ''
    this.soft = soft
    this.hard = hard
    this.pendingEllipsis = false
  }
  push(text) {
    const out = []
    for (const ch of text) {
      // 省略号串（……）结束：先把缓冲（含整串 …）发出去，再开始下一句
      if (this.pendingEllipsis && ch !== '…') {
        this.pendingEllipsis = false
        const b = cleanBubble(this.buf)
        this.buf = ''
        if (b) out.push(...splitLong(b))
      }
      this.buf += ch
      // 遇到省略号先不切，等确认整串结束
      if (ch === '…') {
        this.pendingEllipsis = true
        continue
      }
      let emit = false
      let cutAt = this.buf.length
      // 当前 buffer 末尾是否还处在一对未闭合引号之内
      const inQuote = insideQuote(this.buf, this.buf.length)
      if (inQuote) {
        // 引号还没闭合：不因标点/换行断句，只做「硬上限兜底」，防止超长引号无限膨胀
        if (this.buf.length >= this.hard) {
          emit = true
          cutAt = this.buf.length
        }
      } else if (HARD.has(ch)) {
        emit = true
      } else if (this.buf.length >= this.soft && SOFT.has(ch)) {
        emit = true
      } else if (this.buf.length >= this.hard) {
        // 到硬上限：回退到最近的软断点，别把句子从中间硬切碎
        const idx = Math.max(
          this.buf.lastIndexOf('，'),
          this.buf.lastIndexOf(','),
          this.buf.lastIndexOf('；'),
          this.buf.lastIndexOf(';'),
          this.buf.lastIndexOf('、'),
          this.buf.lastIndexOf('：'),
        )
        emit = true
        if (idx >= this.soft * 0.6) cutAt = idx + 1
      }
      if (emit) {
        // 切点若落在成对引号内部，往前回退，别把引号劈成两半
        cutAt = backOffQuote(this.buf, cutAt, Math.floor(this.soft * 0.6))
        const piece = this.buf.slice(0, cutAt)
        this.buf = this.buf.slice(cutAt)
        const b = cleanBubble(piece)
        if (b) out.push(...splitLong(b))
      }
    }
    return out
  }
  flush() {
    this.pendingEllipsis = false
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

function buildSystem(notes, recallText, backText, factsText, history) {
  const base = promptText().replace('{memory}', memoryBlock(notes))
  let out = base + `\n\n现在是 ${formatNow()}（北京时间）。这是系统提供的准确时间，可信。\n时间只是背景信息，不要根据时间（尤其深夜/凌晨）主动去问对方困不困、要不要睡、怎么还不睡。除非对方自己先提困或睡，你才顺着说。`
  // 时间认知：以「醒」为一天的开始，而不是日历午夜
  try {
    const tb = timeBlock(history)
    if (tb) out += `\n\n${tb}`
  } catch {}
  // 状态层：常驻注入，不依赖检索命中。这是「别把做过的事当成还没做」的关键。
  try {
    const sb = stateBlock(loadState())
    if (sb) out += `\n\n${sb}\n以上是你本来就知道的事，不用特意提起，更不要跟对方核对进度；只是别把它们说错。`
  } catch {}
  if (factsText) out += `\n\n${factsText}`
  if (recallText) out += `\n\n【下面是之前聊到、可能相关的旧事，自然就带一句，别生硬提】\n${recallText}`
  if (backText) out += `\n\n${backText}`
  return out
}

function pad(n) { return String(n).padStart(2, '0') }

function formatNow() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------- 时间认知：以「醒」为一天开始，而不是日历午夜 ----------
// 需求（用户原话）：她最好能大概知道「这一天」做了什么，而且这一天要建立在
// 用户自己的认知上，不是单纯日历。睡和醒是「开始一天」最重要的信号。

// 从最近的历史里找「醒」的信号，判断现在是不是「醒来后的新一天」。
const WAKE_PATTERNS = [/醒了/, /刚醒/, /睡醒/, /起床/, /起来了/, /早安/, /早上好/]
const SLEEP_PATTERNS = [/睡了/, /睡觉/, /去睡/, /晚安/, /睡了觉/, /眯一会/]

// 从后往前找最近的「睡」或「醒」信号（谁更靠后，谁就是最新状态）。
// 返回 { type: 'wake'|'sleep', ts, content }，没找到则 null。
function findWakeSignal(history) {
  if (!Array.isArray(history)) return null
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (!m || m.role !== 'user') continue
    const c = String(m.content || '')
    if (WAKE_PATTERNS.some((p) => p.test(c))) {
      return { type: 'wake', ts: m.ts || Date.now(), content: c }
    }
    if (SLEEP_PATTERNS.some((p) => p.test(c))) {
      return { type: 'sleep', ts: m.ts || Date.now(), content: c }
    }
  }
  return null
}

// 判断对方「现在」是醒着还是睡着/可能睡了。
// 规则：最近的信号是「醒」→ 醒着；最近的信号是「睡」→ 可能已经睡了。
// 没有信号 → unknown，不硬猜。
function sleepState(history) {
  const sig = findWakeSignal(history)
  if (!sig) return 'unknown'
  return sig.type === 'wake' ? 'awake' : 'asleep'
}

// 生成注入系统提示的时间认知块
function timeBlock(history) {
  const now = Date.now()
  const sig = history ? findWakeSignal(history) : null
  const state = sleepState(history)
  const lines = []
  if (sig && sig.ts) {
    const h = Math.round((now - new Date(sig.ts).getTime()) / 3600000)
    const hm = Math.round((now - new Date(sig.ts).getTime()) / 60000)
    if (sig.type === 'wake') {
      if (h >= 1) {
        lines.push(`· 对方最近一次「醒过来」是 ${h} 小时前。在那之后到现在，对对方来说都算「同一天」，中间没睡过觉。`)
      } else if (hm >= 1) {
        lines.push(`· 对方最近一次「醒过来」是 ${hm} 分钟前。从那之后到现在都算「同一天」。`)
      } else {
        lines.push(`· 对方刚刚才醒。`)
      }
    } else {
      // 最近的信号是「睡」：说明对方说过去睡/晚安了，之后没有醒的信号
      if (h >= 1) {
        lines.push(`· 对方 ${h} 小时前说过要睡/去睡了，之后没再说过醒。所以对方现在很可能已经睡了，别问 TA 困不困，也别说「怎么还不睡」。`)
      } else if (hm >= 1) {
        lines.push(`· 对方 ${hm} 分钟前刚说要去睡，现在可能刚躺下，别催。`)
      }
    }
  }
  lines.push('· 判断「今天/昨天」时，以「对方睡醒」为界，不是日历午夜。')
  lines.push('· 如果对方没明确说过睡醒，就别硬分「昨天/今天」，用「几小时前」「刚才」这种相对说法更稳。')
  lines.push('· 对方睡没睡，只以对方自己说的话为准，不要根据现在几点去猜。')
  return lines.length ? '【时间怎么算】\n' + lines.join('\n') : ''
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
  lines.push('以下是你们之前的聊天记录。注意：每条前面「我」代表你自己，「对方」代表和你聊天的人：')
  for (const m of history) {
    const role = m.role === 'user' ? '对方' : '我'
    const ts = formatTs(m.ts)
    if (ts) lines.push(`[${ts}] ${role}：${m.content}`)
    else lines.push(`${role}：${m.content}`)
  }
  lines.push('')
  lines.push('请用你自己的身份接着回。你说话时，「我」就是你，「你」就是对方，别把这两个字说反。')
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

// ---------- 分层记忆：事件卡 + 主动回忆 ----------

function loadMemory() {
  const d = readJsonUrl(EPISODES_URL, null)
  if (d && typeof d === 'object') {
    return {
      cursor: d.cursor && typeof d.cursor === 'object' ? d.cursor : {},
      episodes: Array.isArray(d.episodes) ? d.episodes : [],
      summary: typeof d.summary === 'string' ? d.summary : '',
      weekly: Array.isArray(d.weekly) ? d.weekly : [],
      monthly: Array.isArray(d.monthly) ? d.monthly : [],
    }
  }
  return { cursor: {}, episodes: [], summary: '', weekly: [], monthly: [] }
}

function writeMemory(mem) {
  try { mkdirSync(MEMORY_URL, { recursive: true }) } catch {}
  writeJsonUrl(EPISODES_URL, mem)
}

// ---------- 归纳层：把散落的事件卡/原文整理成一段连贯记忆 ----------
// 这是「搜索 → 整理 → 内化」的关键一步。事件卡是碎片，模型需要先把它们读成
// 一段「这件事到底是什么」，之后才能像真记得一样自然地说出来。
// 按主题词缓存：第一次整理烧一次额度，之后同主题直接读缓存，不再重复调用。

function loadDigest() {
  const d = readJsonUrl(DIGEST_URL, null)
  if (d && typeof d === 'object' && d.items) return d.items
  return {}
}

function writeDigest(items) {
  try { mkdirSync(MEMORY_URL, { recursive: true }) } catch {}
  writeJsonUrl(DIGEST_URL, { items, updatedAt: new Date().toISOString() })
}

// 生成主题键：用用户当前这句话里最具体的实体词（不足则退化为整句哈希）
function digestKey(query, terms) {
  const t = Array.isArray(terms) ? terms.filter((x) => x && x.length >= 2) : []
  if (t.length) return t.slice(0, 3).join('+')
  const s = String(query || '').replace(/\s+/g, '').slice(0, 24)
  return s || 'general'
}

// 把检索到的事件卡和原文片段，整理成「角色自己能说出口」的一段记忆。
// 不写时间线、不写「某年某月」，只提炼「这件事是什么、为什么对她重要」。
async function digestRecall(ctx, query, recall, backText) {
  if (!ctx || !ctx.llm) return ''
  const cards = (Array.isArray(recall) ? recall : []).map((e) => {
    const tag = e.status === 'idea' ? '构想' : e.status === 'plan' ? '说过要做' : '发生过的'
    return `· [${tag}] ${e.theme}：${e.content}`
  })
  const parts = []
  if (cards.length) parts.push('相关记忆卡：\n' + cards.join('\n'))
  if (backText) parts.push('相关原文片段：\n' + backText)
  if (!parts.length) return ''

  const sys = `你是一个聊天角色的记忆整理员。下面是从聊天记录里搜出来的碎片，你需要把它们读成一两句连贯的话，变成「自己确实记得」的口气。

要求：
- 用第一人称「我」回忆，说清这件事/这个东西是什么、跟对方什么关系。
- 不要把多条碎片一条条罗列，要合成一个整体的理解。
- 不要编造碎片里没有的新事实；碎片有出入就拿最可信的那条。
- 只输出这段记忆本身，不要前缀、不要「我记得」开头也可以，直接说。150 字以内。`

  const userText = parts.join('\n\n')
  let text = ''
  try {
    const { provider, model } = extractSelection(tune())
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system: sys,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      temperature: 0.4,
      maxTokens: 300,
      reasoningEffort: 'low',
    })) {
      if (isText(chunk)) text += chunk.text
    }
  } catch {
    return ''
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

// ---------- L0 人物事实层：永久词条，永不删 ----------

function loadFacts() {
  const d = readJsonUrl(FACTS_URL, null)
  if (Array.isArray(d)) return d
  if (d && typeof d === 'object' && Array.isArray(d.facts)) return d.facts
  return []
}

function writeFacts(facts) {
  try { mkdirSync(MEMORY_URL, { recursive: true }) } catch {}
  writeJsonUrl(FACTS_URL, facts)
}

// 敏感词条：仅当用户消息里出现该词条的 key 时才展开，平时不注入
function factsBlockForMessage(msg) {
  const facts = loadFacts()
  if (!facts.length) return ''
  const text = String(msg || '')
  const sensitive = []
  const normal = []
  for (const f of facts) {
    if (!f || typeof f.key !== 'string') continue
    if (f.sensitive) {
      if (text.includes(f.key)) sensitive.push(f)
    } else {
      normal.push(f)
    }
  }
  const pick = (list, max) => list.slice(0, max).map((f) =>
    `· ${f.key}：${(f.facts || []).join('；')}`
  ).join('\n')
  // 普通词条常驻少量，敏感词条只在被提及时才注入
  const parts = []
  if (normal.length) parts.push('【你一直记得的对方的事实】\n' + pick(normal, 20))
  if (sensitive.length) parts.push('【对方主动提到了这些，你才接着聊，平时别主动提】\n' + pick(sensitive, 8))
  return parts.join('\n\n')
}

// 词条编辑/删除（设置面板用）
async function factsPost(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const action = String(body && body.action || 'save')
  const facts = loadFacts()
  if (action === 'save') {
    const key = String(body && body.key || '').trim().slice(0, 24)
    const list = (Array.isArray(body && body.facts) ? body.facts : [])
      .map((s) => String(s || '').trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 20)
    if (!key || !list.length) return sendJson(res, 400, { error: 'bad facts' })
    const idx = facts.findIndex((f) => f && f.key === key)
    const item = { key, facts: list, sensitive: !!body.sensitive }
    if (idx >= 0) facts[idx] = item
    else facts.push(item)
    writeFacts(facts)
    return sendJson(res, 200, { ok: true, facts })
  }
  if (action === 'delete') {
    const key = String(body && body.key || '').trim()
    const next = facts.filter((f) => f && f.key !== key)
    writeFacts(next)
    return sendJson(res, 200, { ok: true, facts: next })
  }
  return sendJson(res, 400, { error: 'bad action' })
}

// ---------- 状态层：把「做了 / 没做」收拾成一小块 ----------
// 设计意图（用户明确要求）：
//  1. 隐性——她不用跟人对进度，只靠这块东西保证说话时别把「做过」当「想做」。
//  2. 大扫除——定期把散乱的卡合并成「已发生」「没发生」，别让两者叠在一起。
//  3. 不催人——悬而未决的事就让它悬着，对方不提就是不重要，绝不许主动提。

function loadState() {
  const d = readJsonUrl(STATE_URL, null)
  if (d && typeof d === 'object') {
    return {
      done: Array.isArray(d.done) ? d.done : [],
      pending: Array.isArray(d.pending) ? d.pending : [],
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
      sweptAt: typeof d.sweptAt === 'string' ? d.sweptAt : '',
    }
  }
  return { done: [], pending: [], updatedAt: '', sweptAt: '' }
}

function writeState(st) {
  try { mkdirSync(MEMORY_URL, { recursive: true }) } catch {}
  writeJsonUrl(STATE_URL, st)
}

// 给模型看的一段极简状态。故意写得很短，别让它变成一份待办清单。
function stateBlock(st) {
  if (!st || (!st.done.length && !st.pending.length)) return ''
  const lines = []
  if (st.done.length) lines.push('已经发生过的：' + st.done.slice(-14).join('；'))
  if (st.pending.length) {
    lines.push('提过但还没做的（对方不提就别当回事，不用问，也不用催）：' + st.pending.slice(-8).join('；'))
  }
  return '【你现在心里有数的状态】\n' + lines.join('\n')
}

function parseEpisodes(text, refTs) {
  let t = String(text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '')
  const i = t.indexOf('[')
  const j = t.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  let arr
  try { arr = JSON.parse(t.slice(i, j + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const now = Date.now()
  // 事件卡 ts 用消息真实时间而不是生成时刻，避免沉降按「生成日期」错位
  const baseTs = refTs ? new Date(refTs).getTime() : now
  return arr
    .filter((e) => e && typeof e === 'object')
    .map((e, k) => ({
      id: 'e-' + now + '-' + k + '-' + Math.random().toString(36).slice(2, 6),
      ts: new Date(baseTs).toISOString(),
      theme: String(e.theme || '').trim().slice(0, 24),
      content: String(e.content || '').trim().slice(0, 60),
      mood: String(e.mood || '').trim().slice(0, 12),
      status: ['done', 'plan', 'idea'].includes(String(e.status || '').trim())
        ? String(e.status).trim()
        : 'done',
      keywords: (Array.isArray(e.keywords) ? e.keywords : [])
        .map((s) => String(s || '').trim())
        .filter((s) => s && s.length <= 20)
        .slice(0, 6),
    }))
    .filter((e) => e.theme || e.content)
}

// L1 -> L2：把超量/超龄的事件卡按时间归档成「周归纳」，永不删除
function sinkEpisodesToWeekly(mem) {
  const eps = mem.episodes || []
  const now = Date.now()
  const recent = []
  const sink = []
  for (const e of eps) {
    const age = e.ts ? (now - new Date(e.ts).getTime()) / 86400000 : 0
    // 先按年龄分开：超龄的必沉降；近期的按时间排序，只保留最新的 MAX_EPISODES 条
    if (age >= EPISODE_SINK_DAYS) sink.push(e)
    else recent.push(e)
  }
  recent.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
  const overflow = recent.length > MAX_EPISODES ? recent.slice(0, recent.length - MAX_EPISODES) : []
  sink.push(...overflow)
  const keep = recent.slice(-MAX_EPISODES)
  mem.episodes = keep
  if (!sink.length) return sink
  // 按天分组（没有 ts 的归到最早）
  const byDay = new Map()
  for (const e of sink) {
    const day = e.ts ? String(e.ts).slice(0, 10) : 'early'
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(e)
  }
  // 合并到现有 weekly，去重按天
  const weekly = Array.isArray(mem.weekly) ? mem.weekly : []
  const weeklyMap = new Map(weekly.map((w) => [String(w.day || ''), w]))
  for (const [day, items] of byDay) {
    const prev = weeklyMap.get(day)
    const lines = items.map((e) => `${e.theme}：${e.content}`).join('\n')
    if (prev) {
      prev.themes = Array.from(new Set([...(prev.themes || []), ...items.map((e) => e.theme)]))
      prev.raw = (prev.raw || '') + '\n' + lines
    } else {
      weeklyMap.set(day, {
        day,
        themes: items.map((e) => e.theme),
        raw: lines,
      })
    }
  }
  mem.weekly = [...weeklyMap.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)))
  if (mem.weekly.length > WEEKLY_MAX) mem.weekly = mem.weekly.slice(-WEEKLY_MAX)
  return sink
}

// L2 -> L3：超龄的周归纳合并成「月印象」，永不删除
function sinkWeeklyToMonthly(mem) {
  const weekly = mem.weekly || []
  const now = Date.now()
  const keep = []
  const sink = []
  for (const w of weekly) {
    const age = w.day && w.day !== 'early' ? (now - new Date(w.day + 'T00:00:00').getTime()) / 86400000 : 999
    if (age < 90) keep.push(w)
    else sink.push(w)
  }
  mem.weekly = keep
  if (!sink.length) return sink
  const byMonth = new Map()
  for (const w of sink) {
    const month = w.day && w.day !== 'early' ? String(w.day).slice(0, 7) : 'early'
    if (!byMonth.has(month)) byMonth.set(month, [])
    byMonth.get(month).push(w)
  }
  const monthly = Array.isArray(mem.monthly) ? mem.monthly : []
  const monthlyMap = new Map(monthly.map((m) => [String(m.month || ''), m]))
  for (const [month, items] of byMonth) {
    const themes = Array.from(new Set(items.flatMap((w) => w.themes || [])))
    const prev = monthlyMap.get(month)
    if (prev) {
      prev.themes = Array.from(new Set([...(prev.themes || []), ...themes]))
      prev.raw = (prev.raw || '') + '\n' + items.map((w) => w.raw || '').join('\n')
    } else {
      monthlyMap.set(month, { month, themes, raw: items.map((w) => w.raw || '').join('\n') })
    }
  }
  mem.monthly = [...monthlyMap.values()].sort((a, b) => String(a.month).localeCompare(String(b.month)))
  return sink
}

let episodeBusy = false

async function maybeGenerateEpisodes(ctx, threadId, messages) {
  if (episodeBusy) return
  const key = threadId || 'default'
  const mem0 = loadMemory()
  let cur = mem0.cursor[key] || 0
  if (messages.length - cur < EPISODE_BATCH) return
  episodeBusy = true
  try {
    // 从上次进度起逐段压缩，直到把现有消息全部压成事件卡（含历史回填）
    let chunks = 0
    while (messages.length - cur >= EPISODE_BATCH && chunks < EPISODE_BACKFILL_MAX) {
      const chunk = messages.slice(cur, cur + EPISODE_WINDOW)
      if (!chunk.length) break
      const prevEps = loadMemory().episodes
      const eps = await compressEpisodes(ctx, chunk, prevEps)
      cur += chunk.length
      const m2 = loadMemory()
      m2.cursor[key] = cur
      if (eps.length) m2.episodes = (m2.episodes || []).concat(eps)
      sinkEpisodesToWeekly(m2)
      sinkWeeklyToMonthly(m2)
      writeMemory(m2)
      chunks += 1
    }
    // 压完顺手做一次大扫除：把状态层重新梳理一遍
    await maybeSweepState(ctx)
  } catch {} finally {
    episodeBusy = false
  }
}

// ---------- 大扫除 ----------
// 把散落的事件卡重建成一小块「已发生 / 没发生」的状态。
// 频率控制：距上次打扫超过 2 小时，并且期间至少新增过一批卡，才做。
const SWEEP_INTERVAL_MS = 2 * 60 * 60 * 1000

async function maybeSweepState(ctx, force) {
  const st0 = loadState()
  if (!force) {
    const last = st0.sweptAt ? new Date(st0.sweptAt).getTime() : 0
    if (Date.now() - last < SWEEP_INTERVAL_MS) return
  }
  const mem = loadMemory()
  const eps = mem.episodes || []
  if (!eps.length && !st0.done.length && !st0.pending.length) return
  try {
    const next = await sweepState(ctx, eps, st0, mem.summary)
    next.sweptAt = new Date().toISOString()
    next.updatedAt = new Date().toISOString()
    writeState(next)
  } catch {}
}

async function sweepState(ctx, episodes, prev, summary) {
  const { provider, model } = extractSelection(tune())
  // 只把最近的卡喂进去；更早的已经进了滚动摘要
  const recent = episodes.slice(-60)
  const lines = recent.map((e) => {
    const tag = e.status === 'plan' ? '[说过要做]' : e.status === 'idea' ? '[随口想想]' : '[已发生]'
    const ts = formatTs(e.ts)
    return `${tag}${ts ? `(${ts})` : ''} ${e.theme}：${e.content}`
  })
  const prevText = (prev.done.length || prev.pending.length)
    ? `\n上一版状态：\n已发生：${prev.done.join('；') || '（空）'}\n没发生：${prev.pending.join('；') || '（空）'}`
    : ''
  const userText = `以下是最近的经历记录：\n${lines.join('\n')}${summary ? `\n\n更早以前：${summary}` : ''}${prevText}

请帮她把状态重新梳理一遍，合并重复的、把后来真做了的改成已发生、把已经不再重要的删掉。
只输出 JSON，不要别的字：
{"done": [ ... ], "pending": [ ... ]}

规则：
- done：**确实已经发生过**的事，每条形如"用手机流量带她出去过一次"，8~20 字，最多 14 条。按时间先后排。
- pending：**提过但确实还没做**的事，5~15 字，最多 8 条。宁少勿滥——对方很久没提的就直接删掉，别留着。
- 两者不要重复。如果某件事先说过要做、后来又真做了，只放进 done。
- 用第三人称描述事情本身就行，不要写成待办清单，不要加"待办""进度""需确认"这类词。`

  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    system: '你在帮忙整理一份长期相处的事实清单。只输出 JSON。',
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    temperature: 0.2,
    maxTokens: 900,
    reasoningEffort: 'low',
  })) {
    if (isText(chunk)) text += chunk.text
  }
  const j = parseJson(text)
  const clean = (arr, max) => (Array.isArray(arr) ? arr : [])
    .map((s) => String(s || '').trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, max)
  const done = clean(j.done, 14)
  const pending = clean(j.pending, 8).filter((p) => !done.some((d) => d === p))
  if (!done.length && !pending.length) throw new Error('sweep empty')
  return { done, pending }
}

async function compressEpisodes(ctx, messages, prevEps) {
  const { provider, model } = extractSelection(tune())
  const lines = messages.map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    const ts = formatTs(m.ts)
    return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`
  })
  // 关键：把「已经有的历史事件卡」喂给压缩模型，让它写新卡前能对照旧记忆。
  // 否则它只看当前这段对话原文，会把「用户早就解释过、但这段里没复述」的事
  // 误写成「未明确说明 / 没说过」，从而制造出「她忘了」的假象。
  let prevText = ''
  const prev = Array.isArray(prevEps) ? prevEps : []
  if (prev.length) {
    const recent = prev.slice(-40)
    prevText = '【已有的记忆卡，写新卡前先对照，别重复也别把它们写成「没说过/未说明」】\n' +
      recent.map((e) => `· ${e.theme}：${e.content}`).join('\n')
  }
  const transcript = lines.join('\n')
  const factsNote = (loadFacts().length)
    ? '\n【已经知道的人物事实，别重复记成事件卡】\n' + loadFacts().map((f) => `${f.key}：${(f.facts || []).join('；')}`).slice(0, 20).join('\n')
    : ''
  const userMsg = prevText
    ? `已有的记忆卡：\n${prevText}\n\n本段对话：\n${transcript}`
    : `本段对话：\n${transcript}`
  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    system: episodesText() + '\n\n【重要】只记值得长期记住的事。对方的想法、创意、构想也要记，但必须用 status 标成 idea（只是构想）或 plan（说要做）；真做过的标 done。棋局对局过程（落子、吃子、走棋步骤、单局胜负）一律不记。哲学闲聊、日常调情、寒暄、情绪流水账一律不记。宁少勿滥，没有值得记的就输出空数组 []。' + factsNote,
    messages: [{ role: 'user', content: [{ type: 'text', text: userMsg }] }],
    temperature: 0.3,
    maxTokens: 2000,
    reasoningEffort: 'low',
  })) {
    if (isText(chunk)) text += chunk.text
  }
  if (!text.trim()) throw new Error('episode stream empty')
  // 用这段对话里最后一条消息的真实时间作为事件卡时间，而不是压缩发生的时刻
  const refTs = messages.length
    ? (messages[messages.length - 1].ts || messages[0].ts || Date.now())
    : Date.now()
  return parseEpisodes(text, refTs)
}

function bigrams(s) {
  const clean = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

function recallEpisodes(query, mem) {
  if (!query || !String(query).trim()) return []
  const q = bigrams(query)
  const ql = String(query).toLowerCase()
  const scored = []
  // L1 近期事件 + L2 周归纳 + L3 月印象，一起搜
  const pool = [
    ...(mem.episodes || []).map((e) => ({ kind: 'episode', e })),
    // 沉降层的完整细节存在 raw 里，唤起时用它而不是只剩标题，别把细节丢掉
    ...(mem.weekly || []).map((w) => ({ kind: 'weekly', e: { theme: '一周：' + String(w.day || ''), content: String(w.raw || (w.themes || []).join('、')).slice(0, 300), keywords: w.themes || [], ts: w.day ? new Date(w.day + 'T00:00:00').toISOString() : '' } })),
    ...(mem.monthly || []).map((m) => ({ kind: 'monthly', e: { theme: '那段时间：' + String(m.month || ''), content: String(m.raw || (m.themes || []).join('、')).slice(0, 300), keywords: m.themes || [], ts: m.month ? new Date(m.month + '-01T00:00:00').toISOString() : '' } })),
  ]
  for (const item of pool) {
    const e = item.e
    const ageDays = e.ts ? Math.max(0, (Date.now() - new Date(e.ts).getTime()) / 86400000) : 365
    const decay = Math.max(0, 1 - ageDays / RECALL_DECAY_DAYS)
    // 1) 关键词命中：强信号（解决「推箱子」→「沉星之序」这类无共同字的情况）
    let kwHit = 0
    for (const kw of e.keywords || []) {
      const k = String(kw).toLowerCase()
      if (k && (ql.includes(k) || k.includes(ql))) kwHit++
    }
    let score = 0
    if (kwHit > 0) {
      score = 0.8 + 0.06 * Math.min(kwHit, 3) + decay * 0.1
    } else if (q.size) {
      // 2) bigram 重叠：弱信号兜底
      const t = bigrams((e.theme || '') + ' ' + (e.content || ''))
      let hit = 0
      if (t.size) for (const b of q) if (t.has(b)) hit++
      if (hit > 0) score = (hit / q.size) * 0.75 + decay * 0.25
    }
    if (score >= RECALL_THRESHOLD) scored.push({ e, score, kind: item.kind })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, RECALL_K).map((s) => s.e)
}

// 「否定记忆」卡：内容声称「没说过/不记得/未说明」的记忆，会教模型否定真实发生过的旧事。
// 召回结果里若同时存在「正面记得」的卡，就把这类卡压到后面甚至剔除。
const NEGATIVE_MEMORY_RE = /(未明确说明|没有明确说明|没说过|未曾说过|没提过|未曾提过|不记得|忘了|没听说过|未提及)/

function dedupNegativeRecall(scored) {
  if (scored.length <= 1) return scored
  const positive = scored.filter((s) => s && !NEGATIVE_MEMORY_RE.test(s.content || '') && !NEGATIVE_MEMORY_RE.test(s.theme || ''))
  const negative = scored.filter((s) => s && (NEGATIVE_MEMORY_RE.test(s.content || '') || NEGATIVE_MEMORY_RE.test(s.theme || '')))
  // 有正面记忆可注入时，否定卡几乎没价值（只会把她「教」忘），直接丢掉
  return positive.length ? positive : negative
}

function recallBlock(eps, summary) {
  if (eps.length) {
    return eps.map((e) => {
      const ts = formatTs(e.ts)
      const when = ts ? `（${ts}）` : ''
      // 带上状态标签：让她分得清「真发生过」和「只是聊过的构想」，别把畅想当事实说。
      const tag = e.status === 'plan' ? '[说过要做]' : e.status === 'idea' ? '[构想]' : '[已发生]'
      return `· ${tag} ${e.theme}${when}：${e.content}${e.mood ? `（${e.mood}）` : ''}`
    }).join('\n')
  }
  return summary ? '更早以前：' + summary : ''
}

// ---------- 事实层：把事件卡的关键词确定性地注入，不依赖 LLM 提取 ----------

function factsBlock() {
  const mem = loadMemory()
  const kws = new Set()
  for (const e of mem.episodes || []) {
    for (const kw of e.keywords || []) {
      const k = String(kw).trim()
      if (k.length >= 2 && k.length <= 24) kws.add(k)
    }
  }
  if (!kws.size) return ''
  return '【对方提过这些名字/作品/关键词，可能被问起】\n' + [...kws].slice(0, 40).join('、')
}

// ---------- 原文回溯：事件卡/notes 没兜住时，去全文里 grep ----------

function queryGrams(query) {
  const c = String(query || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const grams = []
  for (let n = 3; n >= 2; n--) {
    for (let i = 0; i + n <= c.length; i++) grams.push(c.slice(i, i + n))
  }
  return grams
}

// ---------- 回忆式检索：从一句话里剥出真正要搜的实体词 ----------
// 直接拿整句去 bigram 匹配，会被「之前/是不是/跟你说过」这类高频引导语淹没，
// 实测「之前是不是跟你说过小猫团」会命中 207 条噪音。所以先把引导语剥掉。
const RECALL_LEADINS = [
  '你还记不记得', '你记不记得', '记不记得', '还记不记得', '记得不记得',
  '之前是不是', '是不是跟你说过', '是不是说过', '跟你说过', '跟你说过吧',
  '我之前跟你说', '之前跟你聊', '之前跟你讲', '之前说的', '之前聊的',
  '上次说的', '上次聊的', '上次跟你', '之前那个', '上次那个', '那个叫什么',
  '回忆一下', '想一下', '想一想', '想一想看', '你回忆', '我回忆',
  '再回忆', '再想想', '想一想', '想起来', '想起', '回忆起',
  '你还记得吧', '你记得吧', '记得吧', '你还记得我', '你还记得吗',
  '我们聊过', '聊过什么', '提到过', '提过', '说过', '聊过', '讲过',
  '之前', '上次', '以前', '是不是', '你还记得', '还记得', '记得',
  '那个', '那个啥', '什么来着', '叫啥来着', '好像', '有点印象',
  '现在', '你', '我', '再',
]
// 这些词出现才认为对方是在「让我回忆」，否则不搜，避免每句都翻旧账。
const RECALL_CUES = /记不记得|还记得|记得|之前|上次|以前|说过|提过|聊过|讲过|那个啥|什么来着|叫啥来着|我们聊过|有印象|印象里|回忆|想起|想一想|想一下|再想/
// 把整句压成干净的搜索词：去掉引导语、代词、标点。
const RECALL_STOPWORDS = /(我们|你们|他们|你们俩|大家|大家伙|那个|这个|那些|这些|什么|怎么|是不是|有没有|对不对|能不能|可以吗|吗|呢|吧|啊|呀|哦|哈|嘛|了|的|地|得|就|也|还|都|又|再|很|挺|特别|真的|其实|反正|然后|但是|不过|所以|因为|如果|要是|的话|一下|一点|一些|个|只|种|你说|你讲|你提|你聊|叫啥|来着|叫|说|讲|提|聊|们)/g
// 高频虚词：剥离后如果只剩这些，说明这句话没给实体词，不该拿去搜
const RECALL_NOISE = /^(不是|没有|好像|经常|以前|之前|上次|这个|那个|这些|那些|东西|事情|事|话|那个啥|现在|再|又)$/

function extractRecallTerms(query) {
  let s = String(query || '')
  // 长词优先剥，避免「之前是不是」被「之前」先吃掉一半
  const sorted = [...RECALL_LEADINS].sort((a, b) => b.length - a.length)
  for (const w of sorted) s = s.split(w).join(' ')
  s = s.replace(/[，。！？、；：,.!?;:"'“”‘’（）()\[\]【】\s]+/g, ' ')
  const terms = []
  for (const part of s.split(' ')) {
    let t = part.replace(RECALL_STOPWORDS, '').trim()
    // 去掉「经常到X」「要做X」这类动词/副词粘连，只留实体部分
    t = t.replace(/^(经常|常常|老是|总|已经|正在|打算|想要|准备|要做|想|要|做|搞|弄|整|到|过|回忆|想|再|又)+/, '').trim()
    // 单字、以及「桌宠叫」这类动词残留，都不算有效搜索词
    if (t.length >= 2 && t.length <= 12 && !terms.includes(t) &&
        !/(叫|说|讲|提|聊|到)$/.test(t) && !RECALL_NOISE.test(t)) terms.push(t)
  }
  return terms
}

// 同义扩展：对方可能换个叫法说同一件事（猫团子 / 小猫团 / 电子猫）。
const RECALL_ALIASES = [
  ['猫团子', '小猫团', '猫团', '电子猫'],
  ['桌宠', '桌宠娘', '桌面宠物'],
  ['形象', '建模', '皮套', 'vtuber'],
  ['成语接龙', '接龙'],
  ['五子棋', '井字棋'],
]

function expandAliases(terms) {
  const out = terms.slice()
  for (const group of RECALL_ALIASES) {
    if (terms.some((t) => group.some((g) => t.includes(g) || g.includes(t)))) {
      for (const g of group) if (!out.includes(g)) out.push(g)
    }
  }
  return out
}

// 判断这句话是不是在「让我回忆」，并返回要搜的词；不需要搜时返回空数组。
function recallIntent(query) {
  const s = String(query || '')
  const terms = extractRecallTerms(s)
  if (!terms.length) return []
  // 开放式的「我们在聊什么」没有实体词可搜，走事件卡/摘要，不全文乱翻
  if (/^在聊$/.test(terms.join('')) || terms.every((t) => /^(在聊|聊什|什么)$/.test(t))) return []
  // 要么有回忆引导语，要么是用指示代词指代旧事（「那个猫团」这种）。
  // 光有个名词不算——「我想吃火锅」不是让我翻旧账。
  const hasCue = RECALL_CUES.test(s)
  const pointsBack = /那个|那次|那回|那个啥|叫啥|什么来着/.test(s)
  if (!hasCue && !pointsBack) return []
  return expandAliases(terms)
}

// 关键词检索：按词出现次数和词长加权，而不是拿整句 bigram 撞运气。
function searchHistory(full, terms, { hits = 2, window = 2 } = {}) {
  const msgs = Array.isArray(full) ? full : []
  const target = msgs.slice(0, -1) // 排除当前这条用户消息本身
  if (!target.length || !terms.length) return ''
  const scored = []
  for (let i = 0; i < target.length; i++) {
    const c = target[i].content || ''
    if (!c) continue
    let score = 0
    for (const t of terms) {
      if (!t) continue
      let n = 0
      let at = c.indexOf(t)
      while (at >= 0) { n += 1; at = c.indexOf(t, at + t.length) }
      // 长词更可信，短词容易误伤
      if (n > 0) score += n * Math.min(t.length, 4)
    }
    // 对方原话比她自己复述更接近「当初那件事」，同分时优先
    if (score > 0) scored.push({ i, score: score + (target[i].role === 'user' ? 1 : 0) })
  }
  if (!scored.length) return ''
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  // 取分最高的几处，但避免取到几乎挨着的重复位置（同一段事没必要翻两遍）
  const picked = []
  for (const s of scored) {
    if (picked.length >= hits) break
    if (picked.some((p) => Math.abs(p.i - s.i) <= window * 6)) continue
    picked.push(s)
  }
  const idx = new Set()
  for (const p of picked) {
    for (let j = Math.max(0, p.i - window); j <= Math.min(target.length - 1, p.i + window); j++) idx.add(j)
  }
  const lines = [...idx].sort((a, b) => a - b).map((i) => {
    const m = target[i]
    const role = m.role === 'user' ? '对方' : '你'
    const ts = formatTs(m.ts)
    return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`
  })
  return lines.join('\n')
}

// 兼容旧调用：对方是在回忆时，返回注入用的上下文块。
// opts.terms 已给定时直接用它检索（调用方已经判断过意图）。
function backtrackBlock(full, query, opts = {}) {
  const terms = Array.isArray(opts.terms) && opts.terms.length ? opts.terms : recallIntent(query)
  if (!terms.length) return ''
  const body = searchHistory(full, terms, opts)
  if (!body) return ''
  return '【你刚从以前的聊天记录里翻到这几句，可能和对方问的有关】\n' + body +
    '\n（这是翻出来的旧片段，可能不完整、也可能不是对方想的那次；不确定就直说记不清，别硬编。）'
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

// 记忆提取（notes/事件卡）用便宜的快模型，聊天仍用 tune 里的主模型
function extractSelection(cfg) {
  const model = (cfg && cfg.extractModel) ? String(cfg.extractModel) : 'deepseek-flash'
  const provider = (cfg && cfg.provider) || 'deepseek-account'
  return { provider, model }
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
  // 关掉 Nagle：心跳/气泡都是小包，攒 40ms 再发在慢链路上会被放大成明显卡顿
  try { if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true) } catch {}
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
}

function sse(res, obj) {
  if (res.writableEnded || res.destroyed) return
  try {
    res.write('data: ' + JSON.stringify(obj) + '\n\n')
    // 手机走蜂窝/Tailscale 时，内核/TCP 缓冲可能把心跳攒起来再发，导致前端误判「静默」。
    // 显式 flush 一次，让心跳和气泡尽快出网卡。
    if (typeof res.flush === 'function') res.flush()
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// 「额度用完」和「并发被占满」是两件事：
// 前者要用户去续卡，后者等几秒就好，重试一下通常就能过。
// relay 的并发上限是整张卡共享的（实测 3），聊天、记忆提取、标题都在抢这几个位子。
function isBusyError(message) {
  const s = String(message || '')
  if (/余额|额度|积分|到期|用完|不足|insufficient|balance|exhaust|expired/i.test(s)) return false
  return /429|并发|拥挤|稍后重试|rate.?limit|too many|busy/i.test(s)
}

// 服务器到模型中转那一跳的偶发网络抖动（undici 常见报错 + Node 网络错误码）。
// 额度类错误绝不在这里重试，要去续卡，重试也没用。
function isNetworkGlitch(message) {
  const s = String(message || '')
  if (/余额|额度|积分|到期|用完|不足|insufficient|balance|exhaust|expired/i.test(s)) return false
  // 上游中转的 5xx 和「连接在响应前就断了」这类瞬时故障，都算网络抖动，可重试
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|terminated|network|relay 5\d\d|relay 502|relay 503|relay 504|upstream|bad gateway|service unavailable/i.test(s)
}

// 给用户看的报错文案：绝不把 "fetch failed" 这种原文亮出来，太破坏沉浸感。
function friendlyError(message) {
  const s = String(message || '')
  if (/empty-completion/.test(s)) return '刚才那下没接上话，你再说一句？'
  if (isNetworkGlitch(s)) return '刚才网络抖了一下没接上话，你再说一遍好啦'
  if (isBusyError(s)) return '她那边有点挤，稍等一下再发一次'
  return s.slice(0, 300)
}

// ---------- 路由 ----------

// ---------- 语音合成（edge-tts）----------

function ttsVoice() {
  try {
    const cfg = tune()
    return (cfg && cfg.ttsVoice) ? String(cfg.ttsVoice) : TTS_VOICE
  } catch { return TTS_VOICE }
}

function ttsRate() {
  try {
    const cfg = tune()
    return (cfg && cfg.ttsRate) ? String(cfg.ttsRate) : '+15%'
  } catch { return '+15%' }
}

// 把「会被 edge-tts 逐字读出来的颜文字符号」洗掉，只留正常文字。
// 像 (｡･ω･｡) 里的 ω 会被读成"欧米伽"、▽≧☆♡・ 这些也会被读出来，很怪。
// 策略：删掉含颜文字符号的括号及其尾巴，再删游离的孤立符号。
// 正常中文括号（说明）（火锅）保留；emoji（😊😺）保留；英文/日文不误删。
function stripKaomoji(text) {
  let s = String(text || '')
  const pairs = [['(', ')'], ['（', '）'], ['[', ']'], ['【', '】'], ['{', '}'], ['｛', '｝'], ['<', '>'], ['＜', '＞']]
  const esc = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 颜文字符号 = 不是「文字/数字/空白/普通标点/emoji」的字符
  const KAO = /[^\p{L}\p{N}\s，。！？：；、""''「」『』《》（）()\[\]【】{}·\p{Emoji}\uFE0F\u200D]/u
  // 常见颜文字尾巴字符（括号后面跟着的挥手/音符等）
  const TAIL = '[ノﾉヘ♪♫・∴∵وヾﾟﾞ￣]*'
  for (const [open, close] of pairs) {
    const re = new RegExp(esc(open) + '[^' + esc(close) + ']*?' + esc(close) + TAIL, 'g')
    s = s.replace(re, (m) => {
      const closeIdx = m.indexOf(close)
      return KAO.test(m.slice(1, closeIdx)) ? '' : m
    })
  }
  // 删游离的孤立符号（保留 emoji）
  s = s.replace(/[^\p{L}\p{N}\s，。！？：；、""''「」『』《》（）()\[\]【】{}\p{Emoji}\uFE0F\u200D]/gu, '')
  // 删被空白包围的孤立尾巴字符
  s = s.replace(/(?:^|\s)[ノﾉヘ♪♫・∴∵وヾﾟﾞ￣]+(?=\s|$)/g, ' ')
  s = s.replace(/[ ]{2,}/g, ' ').trim()
  return s
}

// 语音生成串行闸门：edge-tts 是外部进程，并发多了会互相抢、生成出截断/空文件。
// 之前前端串行请求天然串行；上一轮加了后端预热后变成并发，才出现的截断。
// 这里统一改成一次只跑一个 edge-tts，其余排队。
let ttsGate = Promise.resolve()
function scheduleTts(task) {
  const run = ttsGate.then(task, task)
  ttsGate = run.then(() => {}, () => {})
  return run
}

async function synthTts(text) {
  const voice = ttsVoice()
  const rate = ttsRate()
  text = stripKaomoji(text)
  const hash = createHash('sha256').update(voice + '\n' + rate + '\n' + text).digest('hex')
  const mp3 = new URL(hash + '.mp3', TTS_URL)
  if (existsSync(mp3)) return mp3
  const old = TTS_INFLIGHT.get(hash)
  if (old) return old
  const job = scheduleTts(async () => {
    // 排队期间可能已经被别的请求生成了，再查一次避免重复生成
    if (existsSync(mp3)) return mp3
    try { mkdirSync(TTS_URL, { recursive: true }) } catch {}
    const txt = new URL(hash + '.txt', TTS_URL)
    writeFileSync(txt, text, 'utf8')
    try {
      await new Promise((resolve, reject) => {
        execFile(
          PYTHON,
          ['-m', 'edge_tts', '--voice', voice, '--rate', rate, '--file', fileURLToPath(txt), '--write-media', fileURLToPath(mp3)],
          { timeout: 30000 },
          (err) => (err ? reject(err) : resolve()),
        )
      })
    } catch (err) {
      // 生成失败/超时：清掉可能残留的空文件，避免下次误当成已生成
      try { rmSync(mp3, { force: true }) } catch {}
      throw err
    }
    // 校验产物：空文件视为失败
    try {
      if (statSync(mp3).size < 1000) {
        rmSync(mp3, { force: true })
        throw new Error('tts output empty')
      }
    } catch (err) {
      if (String(err && err.message) === 'tts output empty') throw err
      throw err
    }
    return mp3
  })
  TTS_INFLIGHT.set(hash, job)
  try {
    return await job
  } finally {
    if (TTS_INFLIGHT.get(hash) === job) TTS_INFLIGHT.delete(hash)
  }
}

const ASSETS = {
  [`${BASE}/app.js`]: ['app.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/style.css`]: ['style.css', 'text/css; charset=utf-8'],
  [`${BASE}/sw.js`]: ['sw.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/avatar.js`]: ['avatar.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/vendor/three.module.js`]: ['vendor/three.module.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/vendor/three.core.js`]: ['vendor/three.core.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/vendor/three-vrm.module.js`]: ['vendor/three-vrm.module.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/vendor/GLTFLoader.js`]: ['vendor/GLTFLoader.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/vendor/utils/BufferGeometryUtils.js`]: ['vendor/utils/BufferGeometryUtils.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/vendor/wukong.js`]: ['vendor/wukong.js', 'application/javascript; charset=utf-8'],
  [`${BASE}/assets/avatar/AliciaSolid.vrm`]: ['assets/avatar/AliciaSolid.vrm', 'model/gltf-binary'],
  [`${BASE}/assets/avatar/Alicia-preview.png`]: ['assets/avatar/Alicia-preview.png', 'image/png'],
}

async function serveGet(request) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || BASE
  const asset = ASSETS[path]
  if (!checkAuth(request.headers) && !asset) return unauthResponse()

  if (path === BASE) {
    return new Response(read('index.html'), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // 页面壳可以短暂复用；对话数据仍由 /current 单独取，不进缓存。
        'cache-control': 'private, max-age=60, stale-while-revalidate=300',
        'set-cookie': `companion_auth=${authCookie()}; Max-Age=2592000; Path=/liao; SameSite=Lax`,
      },
    })
  }
  if (asset) {
    return new Response(readFileSync(new URL(asset[0], ROOT)), {
      headers: {
        'content-type': asset[1],
        // 静态资源按内容版本号（index.html 里的 ?v=）长效缓存：刷新不再重新下载。
        // app.js / style.css / vendor 都走 immutable，更新代码时改 index.html 的版本号即可。
        'cache-control': path === `${BASE}/sw.js`
          ? 'no-cache'
          : path.endsWith('.vrm') || path.endsWith('.js') || path.endsWith('.css')
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=300, must-revalidate',
        ...(path === `${BASE}/sw.js` ? { 'service-worker-allowed': BASE } : {}),
      },
    })
  }
  if (path === `${BASE}/info`) {
    const cfg = tune()
    return jsonResponse({ model: cfg.model, historyTurns: cfg.historyTurns })
  }
  if (path === `${BASE}/current`) {
    const thread = loadCurrent()
    if (!thread) return jsonResponse({ empty: true })
    const all = Array.isArray(thread.messages) ? thread.messages : []
    const aroundParam = url.searchParams.get('around')
    const aroundTs = aroundParam ? Number(aroundParam) : NaN
    if (Number.isFinite(aroundTs) && aroundTs > 0) {
      // 点击引用块定位：按时间戳找到原文，返回它前后一小段，让用户能看到完整上下文
      const pad = Math.max(1, Math.min(parseInt(url.searchParams.get('pad'), 10) || 20, 100))
      const idx = all.findIndex((m) => m && Number(m.ts) === aroundTs)
      if (idx < 0) return jsonResponse({ empty: true, total: all.length })
      const from = Math.max(0, idx - pad)
      const to = Math.min(all.length, idx + pad + 1)
      const messages = all.slice(from, to)
      return jsonResponse({ ...thread, messages, total: all.length, offset: idx, hasMore: true })
    }
    const limitParam = parseInt(url.searchParams.get('limit'), 10)
    const limit = Number.isFinite(limitParam) ? Math.max(20, Math.min(limitParam, 2000)) : 300
    const beforeParam = url.searchParams.get('before')
    const beforeTs = beforeParam ? Number(beforeParam) : NaN
    // 翻页：只取「比某条更早」的记录；无时间戳的老消息视为最早，始终归入最后一批
    const windowMsgs = Number.isFinite(beforeTs) && beforeTs > 0
      ? all.filter((m) => !(m && m.ts) || Number(m.ts) < beforeTs)
      : all
    const messages = windowMsgs.slice(-limit)
    const hasMore = windowMsgs.length > messages.length
    return jsonResponse({ ...thread, messages, total: all.length, hasMore })
  }
  if (path === `${BASE}/search-history`) {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 60)
    if (!q) return jsonResponse({ error: 'bad q' }, 400)
    const thread = loadCurrent()
    if (!thread) return jsonResponse({ hits: [], total: 0 })
    const all = Array.isArray(thread.messages) ? thread.messages : []
    const hits = []
    for (let i = 0; i < all.length; i++) {
      const m = all[i]
      if (!m || typeof m.content !== 'string') continue
      if (!m.content.includes(q)) continue
      // 取前后各 10 句
      const from = Math.max(0, i - 10)
      const to = Math.min(all.length, i + 11)
      const context = all.slice(from, to).map((x) => ({
        role: x && x.role === 'user' ? 'user' : 'assistant',
        content: String(x && x.content || ''),
        ts: x && x.ts ? x.ts : '',
      }))
      hits.push({ index: i, message: m.content, ts: m.ts || '', context })
    }
    return jsonResponse({ hits: hits.slice(0, 20), total: hits.length })
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
  if (path === `${BASE}/episodes`) {
    const mem = loadMemory()
    const eps = (mem.episodes || []).slice().reverse()
    return jsonResponse({
      episodes: eps,
      summary: mem.summary,
      count: eps.length,
      weekly: (mem.weekly || []).slice().reverse(),
      monthly: (mem.monthly || []).slice().reverse(),
    })
  }
  if (path === `${BASE}/facts`) {
    return jsonResponse(loadFacts())
  }
  if (path === `${BASE}/memos`) {
    return jsonResponse({ memos: listMemos() })
  }
  if (path === `${BASE}/memo`) {
    const id = safeId(url.searchParams.get('id'))
    if (!id) return jsonResponse({ error: 'bad id' }, 400)
    const memo = readMemo(id)
    return memo ? jsonResponse(memo) : jsonResponse({ error: 'not found' }, 404)
  }
  if (path === `${BASE}/drawing`) {
    const id = safeId(url.searchParams.get('id'))
    if (!id) return jsonResponse({ error: 'bad id' }, 400)
    const drawing = loadDrawing(id)
    return drawing ? jsonResponse(drawing) : jsonResponse({ error: 'not found' }, 404)
  }
  if (path === `${BASE}/drawings`) {
    return jsonResponse({ drawings: listDrawings() })
  }
  if (path === `${BASE}/albums`) {
    return jsonResponse({ albums: listAlbums() })
  }
  if (path === `${BASE}/chat-bg`) {
    const data = readJsonUrl(CHAT_BG_URL, null)
    const hash = data && typeof data.hash === 'string' ? data.hash : ''
    return jsonResponse({ hash })
  }
  if (path === `${BASE}/tts`) {
    const text = (url.searchParams.get('text') || '').trim()
    if (!text || text.length > 300) return jsonResponse({ error: 'bad text' }, 400)
    try {
      const mp3 = await synthTts(text)
      return new Response(readFileSync(mp3), {
        headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=604800' },
      })
    } catch (error) {
      return jsonResponse({ error: String((error && error.message) || error).slice(0, 160) }, 500)
    }
  }
  if (path.startsWith(`${BASE}/img/`)) {
    const f = imageFile(path.slice(`${BASE}/img/`.length))
    if (!f) return new Response('not found', { status: 404 })
    return new Response(readFileSync(f.url), {
      headers: { 'content-type': f.type, 'cache-control': 'public, max-age=31536000' },
    })
  }
  return new Response('not found', { status: 404 })
}

export function apply(ctx) {
  ensureDirs()
  const disposers = []
  disposers.push(ctx.webServer.register({ kind: 'prefix', path: BASE, resource: serveGet }))
  for (const name of ['chat', 'notes', 'save', 'model', 'mem-edit', 'episode-edit', 'archive-edit', 'game-move', 'game-over', 'memo', 'memo-write', 'drawing', 'draw-ai', 'chat-bg', 'album', 'xq-say', 'xq-over', 'facts']) {
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
  if (!checkAuth(req.headers)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="companion"', 'content-type': 'text/plain; charset=utf-8' })
    res.end('Unauthorized')
    return
  }
  if (name === 'chat') return chat(ctx, req, res)
  if (name === 'game-move') return gameMove(ctx, req, res)
  if (name === 'game-over') return gameOver(ctx, req, res)
  if (name === 'memo') return memoPost(req, res)
  if (name === 'memo-write') return memoWrite(ctx, req, res)
  if (name === 'drawing') return drawingPost(req, res)
  if (name === 'draw-ai') return drawAi(ctx, req, res)
  if (name === 'chat-bg') return chatBgPost(req, res)
  if (name === 'xq-say') return xqSay(ctx, req, res)
  if (name === 'xq-over') return xqOver(ctx, req, res)
  if (name === 'facts') return factsPost(req, res)
  if (name === 'notes') return notes(ctx, req, res)
  if (name === 'save') return save(ctx, req, res)
  if (name === 'model') return setModel(ctx, req, res)
  if (name === 'mem-edit') return memEdit(ctx, req, res)
  if (name === 'episode-edit') return episodeEdit(ctx, req, res)
  if (name === 'archive-edit') return archiveEdit(req, res)
  if (name === 'album') return albumPost(req, res)
}

// ---------- 切换模型 ----------

async function setModel(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const model = String((body && body.model) || '').trim()
  if (model !== 'deepseek-flash' && model !== 'deepseek-v4-pro') {
    return sendJson(res, 400, { error: 'bad model' })
  }
  try {
    writeTune({ model })
    return sendJson(res, 200, { ok: true, model })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
  }
}

// ---------- 手动编辑 / 删除记忆（notes） ----------

// body: { threadId, field, index, action: 'edit'|'delete', text }
// field 是四类之一（about_you / how_to_talk / between_us / about_me），index 是该类里的第几条
async function memEdit(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const threadId = safeId(body && body.threadId)
  const field = String(body && body.field || '')
  const action = String(body && body.action || '')
  if (!threadId || !FIELDS.includes(field) || !['edit', 'delete'].includes(action)) {
    return sendJson(res, 400, { error: 'bad params' })
  }
  const idx = Number(body && body.index)
  if (!Number.isInteger(idx) || idx < 0) {
    return sendJson(res, 400, { error: 'bad index' })
  }
  try {
    const thread = readJsonUrl(threadUrl(threadId), null)
    if (!thread || !Array.isArray(thread.messages)) {
      return sendJson(res, 404, { error: 'thread not found' })
    }
    const notes = cleanNotes(thread.notes)
    const list = notes[field] || []
    if (idx >= list.length) {
      return sendJson(res, 400, { error: 'index out of range' })
    }
    if (action === 'delete') {
      list.splice(idx, 1)
    } else {
      const text = String(body && body.text || '').trim()
      if (!text) return sendJson(res, 400, { error: 'empty text' })
      list[idx] = text
    }
    notes[field] = list
    thread.notes = notes
    thread.updatedAt = new Date().toISOString()
    writeJsonUrl(threadUrl(threadId), thread)
    return sendJson(res, 200, { ok: true, notes })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
  }
}

// ---------- 手动编辑 / 删除事件卡 ----------

// body: { id, action: 'edit'|'delete', theme, content, mood, status }
async function episodeEdit(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const id = String(body && body.id || '').trim()
  const action = String(body && body.action || '')
  if (!id || !['edit', 'delete'].includes(action)) {
    return sendJson(res, 400, { error: 'bad params' })
  }
  try {
    const mem = loadMemory()
    const eps = mem.episodes || []
    const i = eps.findIndex((e) => e && e.id === id)
    if (i < 0) {
      return sendJson(res, 404, { error: 'episode not found' })
    }
    if (action === 'delete') {
      eps.splice(i, 1)
    } else {
      const e = eps[i]
      if (body && body.theme != null) e.theme = String(body.theme).trim().slice(0, 24)
      if (body && body.content != null) e.content = String(body.content).trim().slice(0, 60)
      if (body && body.mood != null) e.mood = String(body.mood).trim().slice(0, 12)
      if (body && body.status != null) {
        e.status = ['done', 'plan', 'idea'].includes(String(body.status)) ? String(body.status) : e.status
      }
    }
    mem.episodes = eps
    writeMemory(mem)
    return sendJson(res, 200, { ok: true, episodes: eps.slice().reverse() })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
  }
}

// ---------- 周归纳 / 月印象 编辑 ----------
// 沉降层的 raw 是完整细节，但 day/month 可能因为补提时间戳而错位。
// 给用户一个可改入口：改日期标签 + 改原始文本，themes 从 raw 自动重提。
async function archiveEdit(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const kind = String(body && body.kind || '')
  const action = String(body && body.action || '')
  if (!['weekly', 'monthly'].includes(kind) || !['edit', 'delete'].includes(action)) {
    return sendJson(res, 400, { error: 'bad params' })
  }
  const key = String(body && body.key || '').trim()
  if (!key) return sendJson(res, 400, { error: 'bad key' })
  try {
    const mem = loadMemory()
    const arr = kind === 'weekly' ? (mem.weekly || []) : (mem.monthly || [])
    const idx = arr.findIndex((x) => x && String(x[kind === 'weekly' ? 'day' : 'month']) === key)
    if (idx < 0) return sendJson(res, 404, { error: 'not found' })
    if (action === 'delete') {
      arr.splice(idx, 1)
    } else {
      const e = arr[idx]
      if (kind === 'weekly') {
        if (body && body.day != null) e.day = String(body.day).trim().slice(0, 10)
        if (body && body.raw != null) {
          e.raw = String(body.raw).slice(0, 200000)
          // 每行「主题：内容」的冒号前部分是 theme，从改后的 raw 重提
          e.themes = e.raw.split('\n').map((l) => l.split('：')[0].trim()).filter(Boolean)
        }
      } else {
        if (body && body.month != null) e.month = String(body.month).trim().slice(0, 7)
        if (body && body.raw != null) {
          e.raw = String(body.raw).slice(0, 200000)
          e.themes = e.raw.split('\n').map((l) => l.split('：')[0].trim()).filter(Boolean)
        }
      }
    }
    if (kind === 'weekly') mem.weekly = arr
    else mem.monthly = arr
    writeMemory(mem)
    return sendJson(res, 200, { ok: true })
  } catch (error) {
    return sendJson(res, 500, { error: String((error && error.message) || error).slice(0, 160) })
  }
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
    // 关键：不能用 normRealMessages（内部 slice(-4000)）——cursor 是全局索引，
    // 消息超过 4000 条后会被截断，messages.length - cursor 变成负数，事件卡从此停摆。
    // 这里传完整消息，只过滤掉游戏心声，不截断。
    const epiMsgs = (thread.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && !(m.meta && m.meta.game))
    maybeGenerateEpisodes(ctx, thread.threadId, epiMsgs)
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
  const game = body && body.game ? body.game : null
  const memo = body && body.memo ? body.memo : null
  // 前端开了自动朗读才预热语音：流式吐字的同时把 edge-tts 生成跑起来，
  // 等前端来取 /tts 时多半已经生成好，只剩下载，手机流量下省掉生成等待。
  const wantTts = !!(body && body.tts)
  // 微信式引用：从最后一条用户消息的 meta.quote 提取被引用的原文
  // 注意：引用可能是单独一条消息，附话是下一条，所以要找最近一条带 meta.quote 的 user 消息
  const quotedMsg = [...normMessages(body && body.messages)].reverse().find((m) => m.role === 'user' && m.meta && typeof m.meta.quote === 'string')
  const quoteText = quotedMsg && quotedMsg.meta && typeof quotedMsg.meta.quote === 'string'
    ? quotedMsg.meta.quote.slice(0, 2000)
    : ''
  const drawingImage = typeof body && body.drawingImage === 'string' && body.drawingImage.startsWith('data:image/') ? body.drawingImage : ''
  const full = normMessages(body && body.messages)
  const history = full.slice(-cfg.historyTurns)
  const imageList = Array.isArray(body && body.images)
    ? body.images
    : (body && typeof body.image === 'string' ? [body.image] : [])
  const validImages = imageList.filter((u) => typeof u === 'string' && u.startsWith('data:image/')).slice(0, 9)
  const imgHashes = validImages.map((u) => saveImage(u)).filter(Boolean)

  // 主动回忆 + 原文回溯
  const mem = loadMemory()
  const lastUser = [...full].reverse().find((m) => m.role === 'user')
  const recall = lastUser ? dedupNegativeRecall(recallEpisodes(lastUser.content, mem)) : []
  const recallStr = lastUser ? recallBlock(recall, mem.summary) : ''
  // 何时才去翻全文：对方明确在让我回忆，或者事件卡命中了但内容明显残缺。
  // 其余情况一律不搜，避免每句话都去翻旧账。
  let backStr = ''
  if (lastUser) {
    let terms = recallIntent(lastUser.content)
    // 事件卡命中时，用卡里的关键词补一轮：能接住「对方只说了半句、我想顺着旧事往下聊」的情况
    if (!terms.length && recall.length) {
      const kw = recall.flatMap((e) => (Array.isArray(e.keywords) ? e.keywords : []))
        .map((s) => String(s || '').trim())
        .filter((s) => s.length >= 2 && lastUser.content.includes(s))
      if (kw.length) terms = expandAliases(kw)
    }
    // 事件卡命中却没说清（内容很短/带未说明字样），说明记忆残缺，值得回原文补齐
    const thinRecall = recall.some((e) => {
      const body = String((e && e.content) || '')
      return body.length < 24 || NEGATIVE_MEMORY_RE.test(body)
    })
    if (terms.length || thinRecall) {
      // 有明确实体词就直接用它搜；只有残缺卡时，用对方原话里的词去搜
      const searchTerms = terms.length ? terms : extractRecallTerms(lastUser.content)
      // 关键：前端只发最近几十条，翻旧账必须用服务端全量记录，否则搜不到更早的事
      const stored = loadCurrent()
      const storedMsgs = stored && Array.isArray(stored.messages) ? normMessages(stored.messages) : []
      const searchPool = storedMsgs.length > full.length ? storedMsgs : full
      // 把当前这条用户消息临时拼到末尾，让 backtrackBlock 的「排除最后一条」逻辑仍然成立
      const poolWithCurrent = searchPool.concat([lastUser])
      backStr = backtrackBlock(poolWithCurrent, lastUser.content, { terms: searchTerms, hits: 2, window: 1 })
    }
  }
  // 归纳层：把搜到的碎片读成一段连贯记忆。对方明确在回忆时才做，且按主题词缓存。
  let digestText = ''
  const recallTerms = lastUser ? recallIntent(lastUser.content) : []
  // 只有对方明确在「回忆某件事」时才整理；普通闲聊即使事件卡误命中也不触发。
  // 否则发张照片、聊句天气都会被当成旧事去整理，既烧额度又污染缓存。
  if (lastUser && recallTerms.length) {
    const key = digestKey(lastUser.content, recallTerms)
    const digests = loadDigest()
    if (digests[key]) {
      digestText = String(digests[key])
    } else {
      // 缓存没有就不阻塞主聊天：先用原始碎片正常接话，整理放到后台异步做，
      // 下一次再聊同一主题时缓存就绪，她就能准确说出来了。避免「一回忆就卡住等好久」。
      const recallSnapshot = recall.slice()
      const backSnapshot = backStr
      ;(async () => {
        const text = await digestRecall(ctx, lastUser.content, recallSnapshot, backSnapshot)
        if (!text) return
        const cur = loadDigest()
        cur[key] = text
        const entries = Object.entries(cur)
        const trimmed = {}
        for (const [k, v] of entries.slice(-30)) trimmed[k] = v
        writeDigest(trimmed)
      })()
    }
  }
  // 旧的关键词注入 + 新的 L0 词条层（含敏感词条按需展开）
  const factsStr = factsBlock() + '\n\n' + (lastUser ? factsBlockForMessage(lastUser.content) : '')

  // 微信式引用：在历史里定位被引用的句子，取该句附近少量上下文，供她自行判断需要多少
  let quoteContextText = ''
  if (quoteText) {
    // 优先去服务端全量历史里定位：前端发来的只是最近几十条，引用的原文可能早已滚出窗口，
    // 光靠 body.messages 会定位失败、退化成只有几个字，让模型理解成残缺内容。
    let all = normMessages(body && body.messages)
    const quoteTs = quotedMsg && quotedMsg.meta && Number(quotedMsg.meta.quoteTs)
    const stored = loadCurrent()
    const storedMsgs = stored && Array.isArray(stored.messages) ? normMessages(stored.messages) : []
    if (storedMsgs.length > all.length) all = storedMsgs
    const norm = (s) => String(s || '').replace(/\s+/g, '')
    const target = norm(quoteText)
    let found = false
    if (target) {
      // 先按时间戳精确找（引用的是哪条就是哪条，避免同文案在不同位置被误定位）
      const tsIndex = Number.isFinite(quoteTs) && quoteTs > 0
        ? all.findIndex((m) => Number(m && m.ts) === quoteTs)
        : -1
      const start = tsIndex >= 0 ? tsIndex : 0
      const end = tsIndex >= 0 ? tsIndex + 1 : all.length
      for (let i = start; i < end; i++) {
        const cur = norm(all[i].content)
        if (cur === target || (cur && cur.includes(target)) || (target && target.includes(cur))) {
          // 上下文扩到前后各 6 句，覆盖成语接龙这类「一轮多句」的完整来龙去脉
          const from = Math.max(0, i - 6)
          const to = Math.min(all.length, i + 7)
          quoteContextText = all.slice(from, to).map((m) => {
            const role = m.role === 'user' ? '对方' : '你'
            return `${role}：${m.content}`
          }).join('\n')
          found = true
          break
        }
      }
    }
    // 定位失败也要让模型看到被引用的原文，不能假装没这回事
    if (!found) {
      quoteContextText = '对方引用的话：' + quoteText
    }
  }

  const { provider, model } = selection(ctx, cfg)
  const splitter = new Splitter(cfg.bubbleSoft, cfg.bubbleHard)
  const abort = new AbortController()
  req.on('close', () => abort.abort())

  openSse(res)
  sse(res, { type: 'info', provider, model, sent: history.length, limit: cfg.historyTurns, imgs: imgHashes })

  let count = 0
  let tail = ''
  const emit = (bubble) => {
    count += 1
    if (count > cfg.maxBubbles) { tail += bubble; return }
    sse(res, { type: 'bubble', text: bubble })
    if (wantTts) synthTts(bubble).catch(() => {})
  }

  // 心跳 + 死等保护
  // 模型可能迟迟不吐第一个字（排队、思考、网络慢），这段时间前端是完全静默的。
  // 所以由后端每 2 秒明确说一声「还在」，前端就不会把「慢」当成「卡死」。
  // 反过来，若连一个 chunk 都迟迟不来，后端主动收摊并说清楚，别让前端无限干等。
  const HEARTBEAT_MS = 2000
  const STALL_MS = 90000
  const MAX_BUSY_ATTEMPTS = 4
  const BUSY_BASE_MS = 1500

  let lastActivity = Date.now()
  let stalled = false
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return
    if (count === 0 && Date.now() - lastActivity > STALL_MS) {
      stalled = true
      try { abort.abort() } catch {}
      return
    }
    sse(res, { type: 'thinking' })
  }, HEARTBEAT_MS)

  try {
    let attempt = 0
    let netAttempts = 0
    let emptyAttempts = 0
    for (;;) {
      attempt += 1
      try {
        let transcriptText = buildTranscript(history)
        if (drawingImage) transcriptText += '\n\n【注意】对方把画板上的涂鸦发给你看了，图在这条消息的附件里。这是一张随手画的简笔画，可能很粗糙。聊到画的内容时：\n· 先照图里真实看到的说（有几条线、几个形状、大概在什么位置）。\n· 然后用「看起来像……」的方式猜，允许说「像花」「像猫」但别下死结论。\n· 看不清或完全没认出来，就直说「我有点看不清」，绝不许编造图里根本没有的东西。'
        const userContent = [{ type: 'text', text: transcriptText }]
        for (const u of validImages) userContent.push({ type: 'image_url', image_url: { url: u } })
        if (drawingImage) userContent.push({ type: 'image_url', image_url: { url: drawingImage } })
        const options = {
          provider,
          model,
          system: buildSystem(memory, recallStr, backStr, factsStr, history)
            + (digestText ? '\n\n【你已经想起来的这段记忆，直接用这个口吻说，别再说「记不清」】\n' + digestText : '')
            + (gameBlock(game) ? '\n\n' + gameBlock(game) : '\n\n【关于棋局】如果对方提到下棋、复盘或这局怎么下的，你现在手上没有具体棋局面，直接说记不清或不知道，绝不许自己编造棋盘或结果。')
            + (memoBlock(memo) ? '\n\n' + memoBlock(memo) : '')
            + (quoteContextText ? '\n\n【对方引用了一句你们之前说过的话】\n' + quoteContextText + '\n\n请结合这段话接话，不用再翻更多，找到答案就停。' : ''),
          messages: [{ role: 'user', content: userContent }],
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
          reasoningEffort: cfg.reasoningEffort,
          signal: abort.signal,
        }
        for await (const chunk of ctx.llm.stream(options)) {
          lastActivity = Date.now()
          if (isText(chunk)) {
            for (const b of splitter.push(chunk.text)) emit(b)
          } else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
            sse(res, { type: 'error', message: friendlyError((chunk.reason.failure && chunk.reason.failure.message) || '模型出错了') })
          }
        }
        for (const b of splitter.flush()) emit(b)
        if (tail) {
          sse(res, { type: 'bubble', text: tail })
          if (wantTts) synthTts(tail).catch(() => {})
        }
        // 官方接口偶发返回「finish=stop 但 content 为空」的空回复（实测约一半概率）。
        // 这时下面没有气泡可发，前端只会收到 thinking 和 done，表现成「正在输入消失后什么都没发生」。
        // 所以空回复当异常处理，走重试；重试也空才报错，绝不让它静默结束。
        if (count === 0) throw new Error('empty-completion')
        break
      } catch (error) {
        const msg = String((error && error.message) || error)
        // 并发被占满 / 网络抖动 / 空回复：还没出过气泡时都原地重试，别把原始报错撒给用户。
        const isEmpty = msg === 'empty-completion'
        const retryable = count === 0 && (isBusyError(msg) || isNetworkGlitch(msg) || isEmpty)
        if (!stalled && retryable && (isBusyError(msg) ? attempt < MAX_BUSY_ATTEMPTS : isEmpty ? emptyAttempts < 2 : netAttempts < 3)) {
          if (isBusyError(msg)) {
            const waitMs = BUSY_BASE_MS * attempt
            sse(res, { type: 'wait', ms: waitMs, text: '她那边有点挤，我排一下队…' })
            await sleep(waitMs)
          } else if (isEmpty) {
            // 空回复既不是网络问题也不是额度问题，重问一次通常就有内容，不打扰用户
            emptyAttempts += 1
            console.log(`[chat] 空回复，重试 ${emptyAttempts}/2`)
            await sleep(600 * emptyAttempts)
          } else {
            netAttempts += 1
            const waitMs = 1500 * netAttempts
            await sleep(waitMs)
          }
          lastActivity = Date.now()
          continue
        }
        throw error
      }
    }
  } catch (error) {
    const isQuota = !!(error && error.quota)
    if (stalled) {
      sse(res, { type: 'error', message: '这次等太久没等到回复，你再说一句，我重新接。' })
    } else {
      sse(res, { type: 'error', message: friendlyError((error && error.message) || error), quota: isQuota })
    }
  } finally {
    clearInterval(heartbeat)
    sse(res, { type: 'done' })
    if (!res.writableEnded) res.end()
  }
}

// ---------- 下棋：让小喵（语言模型）本人落子，而不是规则引擎 ----------
// 设计要点：
//  1. 决策来自小喵这个人格（复用聊天同一套 prompt + 记忆），而不是冷冰冰的 minimax。
//  2. 输出严格约束成坐标，后端做合法性校验；模型抽风时用「第一个空位」兜底，保证棋局不卡死。
//  3. 兜底只是防死机，平时都是她自己在想；返回里带 fallback 标记，前端可选展示。

// board 是一维长度 9 的数组，值只能是 'user'（对方/用户）、'assistant'（小喵/我）或 ''（空）。
// 坐标约定：x=行、y=列，左上角是 (0,0)，右下角是 (2,2)。
function boardToText(board) {
  const rows = []
  for (let r = 0; r < 3; r++) {
    const cells = []
    for (let c = 0; c < 3; c++) {
      const v = board[r * 3 + c]
      cells.push(v === 'user' ? '对方' : v === 'assistant' ? '我' : '·')
    }
    rows.push(`第${r}行（列 0~2）：${cells.join(' ')}`)
  }
  return rows.join('\n')
}

// 找井字棋里的「关键格」：自己两连可直接赢，对方两连必须堵。
// 返回 { index, kind }，kind 是 'win'（赢）或 'block'（堵），没有则 null。
function criticalCell(board) {
  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ]
  let block = null
  for (const [a, b, c] of LINES) {
    const cells = [board[a], board[b], board[c]]
    const mine = cells.filter((x) => x === 'assistant').length
    const theirs = cells.filter((x) => x === 'user').length
    const emptyIdx = cells.indexOf('')
    if (emptyIdx < 0) continue
    if (mine === 2) return { index: [a, b, c][emptyIdx], kind: 'win' }
    if (theirs === 2 && !block) block = { index: [a, b, c][emptyIdx], kind: 'block' }
  }
  return block
}

// ---------- 五子棋 ----------
// 在 idx 落 player 后，是否在横/竖/两条对角线上连成至少 5 子。
function gomokuWinsAt(board, size, idx, player) {
  const row = Math.floor(idx / size)
  const col = idx % size
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]]
  for (const [dr, dc] of dirs) {
    let count = 1
    for (let step = -1; step <= 1; step += 2) {
      let r = row + dr * step
      let c = col + dc * step
      while (r >= 0 && r < size && c >= 0 && c < size && board[r * size + c] === player) {
        count++
        r += dr * step
        c += dc * step
      }
    }
    if (count >= 5) return true
  }
  return false
}

// 返回 player 落子后能直接连成五的所有空位 index（赢点）。
function gomokuWinMoves(board, size, player) {
  const out = []
  for (let i = 0; i < size * size; i++) {
    if (board[i] !== '') continue
    if (gomokuWinsAt(board, size, i, player)) out.push(i)
  }
  return out
}

// 单条线的价值：count=连子数，openEnds=两端开放空位数。
function gomokuLineScore(count, openEnds) {
  if (count >= 5) return 1000000
  if (count === 4) return openEnds >= 2 ? 100000 : (openEnds === 1 ? 10000 : 0)
  if (count === 3) return openEnds >= 2 ? 10000 : (openEnds === 1 ? 1000 : 0)
  if (count === 2) return openEnds >= 2 ? 1000 : (openEnds === 1 ? 100 : 0)
  if (count === 1) return openEnds >= 2 ? 100 : (openEnds === 1 ? 10 : 0)
  return 0
}

// 在 (row,col) 放 player 后，评估该点四个方向的攻防价值。
function gomokuPointScore(board, size, row, col, player) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]]
  let total = 0
  for (const [dr, dc] of dirs) {
    let count = 1
    let openEnds = 0
    for (const sign of [1, -1]) {
      let r = row + dr * sign
      let c = col + dc * sign
      while (r >= 0 && r < size && c >= 0 && c < size && board[r * size + c] === player) {
        count++
        r += dr * sign
        c += dc * sign
      }
      if (r >= 0 && r < size && c >= 0 && c < size && board[r * size + c] === '') openEnds++
    }
    total += gomokuLineScore(count, openEnds)
  }
  return total
}

// 规则引擎选点：保证「分得清黑白、该堵会堵、该赢会赢」。
// 没有强威胁时保留一点随性（在分数接近的候选里随机），符合小喵人设，而不是不败电脑。
function gomokuBestMove(board, size) {
  let best = []
  let bestScore = -1
  for (let i = 0; i < size * size; i++) {
    if (board[i] !== '') continue
    const row = Math.floor(i / size)
    const col = i % size
    const attack = gomokuPointScore(board, size, row, col, 'assistant')
    const defend = gomokuPointScore(board, size, row, col, 'user')
    const score = Math.max(attack, defend * 0.95)
    if (score > bestScore) {
      bestScore = score
      best = [i]
    } else if (score === bestScore) {
      best.push(i)
    }
  }
  if (!best.length) return -1
  // 有强威胁（自己四连可赢 / 对方四连必堵）时严格走最优
  if (bestScore >= 10000) return best[0]
  // 否则在分数 >= 最高分 0.75 的候选里随机，保留随性
  const pool = best.filter((i) => {
    const row = Math.floor(i / size), col = i % size
    const attack = gomokuPointScore(board, size, row, col, 'assistant')
    const defend = gomokuPointScore(board, size, row, col, 'user')
    return Math.max(attack, defend * 0.95) >= bestScore * 0.75
  })
  return pool[Math.floor(Math.random() * pool.length)]
}

// 五子棋棋盘文字摘要：不列 225 个格子，只列双方已有的子（按坐标）。
function gomokuBoardSummary(board, size) {
  const mine = []
  const theirs = []
  for (let i = 0; i < size * size; i++) {
    const v = board[i]
    if (v === 'assistant') mine.push(`(${Math.floor(i / size)},${i % size})`)
    else if (v === 'user') theirs.push(`(${Math.floor(i / size)},${i % size})`)
  }
  const cap = 80
  const m = mine.slice(0, cap).join('、') || '（暂无）'
  const t = theirs.slice(0, cap).join('、') || '（暂无）'
  return `我的子（白）共 ${mine.length} 枚：${m}\n对方的子（黑）共 ${theirs.length} 枚：${t}`
}

// 聊天时把当前棋局作为背景注入给小喵，让她边下边聊、知道棋盘发生了什么。
function gameBlock(game) {
  if (game && game.kind === 'gomoku') {
    const b = Array.isArray(game.board) ? game.board : []
    const size = Number(game.size) || 15
    if (b.length !== size * size) return ''
    // 空棋盘不算「正在下棋」，不注入，避免她凭空催人下棋
    if (!b.some((x) => x)) return ''
    const over = !!game.over
    const winner = game.winner === 'user' ? '对方' : game.winner === 'assistant' ? '我' : game.winner === 'draw' ? '平局' : ''
    if (over) {
      return `【你们刚下完一局五子棋，已经结束】结果：${winner}。棋面摘要（「我」=白、「对方」=黑）：\n${gomokuBoardSummary(b, size)}\n\n对方如果跟你复盘、问这局怎么下的，就照这个摘要如实说；记不清哪一步先后就说记不清，绝不许自己编一套棋路或结果。`
    }
    const turn = game.turn === 'user' ? '对方' : '我'
    return `【你们正在下五子棋】棋盘 ${size}×${size}，行列都从 0 到 ${size - 1}。对方执黑、你执白。棋面摘要（「我」=白、「对方」=黑）：\n${gomokuBoardSummary(b, size)}\n现在轮到：${turn}。聊的时候自然带上棋局就行，别生硬汇报全部坐标、别念规则。`
  }
  if (!game || game.kind !== 'tictactoe') return ''
  const b = Array.isArray(game.board) ? game.board : []
  if (b.length !== 9) return ''
  if (!b.some((x) => x)) return ''
  const over = !!game.over
  const winner = game.winner === 'user' ? '对方' : game.winner === 'assistant' ? '我' : game.winner === 'draw' ? '平局' : ''
  if (over) {
      return `【你们刚下完一局井字棋，已经结束】结果：${winner}。最终棋盘如下（「对方」=对方、「我」=你自己、「·」=空位）：\n${boardToText(b)}\n\n对方如果跟你复盘、问这局怎么下的，就照这个最终棋盘如实说；记不清哪一步先后就说记不清，绝不许自己编一套棋路或结果。`
  }
  const turn = game.turn === 'user' ? '对方' : '我'
  return `【你们正在下井字棋】棋盘如下（「对方」=对方、「我」=你自己、「·」=空位）：\n${boardToText(b)}\n现在轮到：${turn}。聊的时候自然带上棋局就行，别生硬汇报棋盘、别念规则。`
}

// 聊天时把当前便签内容注入给小喵，让她能「看到」纸上写了什么。
function memoBlock(memo) {
  if (!memo || typeof memo.content !== 'string') return ''
  const text = memo.content.trim().slice(0, 12000)
  if (!text) {
    return `【你们有一张空白的便签纸，还没写任何字】对方刚开了一张新纸。\n\n如果聊到这张纸，你可以自然地讨论；往纸上写字由系统单独处理，你不需要在聊天里输出任何特殊标记。`
  }
  // 用作者记录还原「这张纸是怎么写出来的」
  const authors = (memo.events && Array.isArray(memo.events)) ? memo.events.slice(-30) : []
  let history = ''
  if (authors.length) {
    const lines = authors.map((a) => {
      const who = a.author === 'assistant' ? '你自己（我）' : '对方'
      const piece = String(a.text || a.content || '').trim().slice(0, 300)
      return piece ? `${who}写了：${piece}` : ''
    })
    history = lines.filter(Boolean).join('\n')
  } else {
    history = `（这张纸的完整内容是：）\n${text}`
  }
  return `【你们有一张正在写的便签纸】下面是这张纸的来龙去脉（谁写了什么）：\n${history}\n\n你现在看到的纸上内容是：\n${text}\n\n【你要记住】\n· 上面标了「你自己（我）写的」是你之前写过的，「对方写的」是对方写的，别记反。\n· 不要复述、重复或抄写对方已经写的内容，那会让对方觉得你在敷衍。\n· 聊到这张纸时，要像知道它的前因后果一样，而不是第一次看见。\n\n【关于往纸上写】现在往纸上写是由系统单独处理的（对方会点按钮触发），你在聊天里只需要讨论纸上的内容，不需要自己用任何标记去写纸。`
}

async function gameMove(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const kind = body && body.kind === 'gomoku' ? 'gomoku' : 'tictactoe'
  if (kind === 'gomoku') return gomokuMove(ctx, req, res, body)
  return tictactoeMove(ctx, req, res, body)
}

async function tictactoeMove(ctx, req, res, body) {
  const board = Array.isArray(body && body.board) ? body.board : []
  if (board.length !== 9) return sendJson(res, 400, { error: 'bad board' })

  const empty = []
  for (let i = 0; i < 9; i++) {
    const v = board[i]
    if (v !== 'user' && v !== 'assistant') empty.push(i)
  }
  if (!empty.length) return sendJson(res, 200, { move: null, gameOver: true })

  const cfg = tune()
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-cfg.historyTurns)
  const { provider, model } = selection(ctx, cfg)

  const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : ''
  const critical = criticalCell(board)
  const criticalHint = critical
    ? critical.kind === 'win'
      ? `\n\n【关键一步】你现在已经有两个棋子在一条线上，只差一格就能连成三子赢下这局。那格是第 ${Math.floor(critical.index / 3)} 行第 ${critical.index % 3} 列（坐标 x=${Math.floor(critical.index / 3)}, y=${critical.index % 3}）。请你下在这里，并用自己的话说一句「要赢了」之类的话。`
      : `\n\n【关键一步】对方已经有两个棋子在一条线上，第三格还空着，你必须下在那个空位堵住，否则对方下一步就赢了。那格是第 ${Math.floor(critical.index / 3)} 行第 ${critical.index % 3} 列（坐标 x=${Math.floor(critical.index / 3)}, y=${critical.index % 3}）。请你下在这里，并用自己的话说一句在堵对方。`
    : ''

  const system = promptText().replace('{memory}', memoryBlock(memory)) +
    `\n\n你现在正跟朋友下井字棋。棋盘是 3×3，行和列都从 0 到 2，左上角是 (0,0)、右下角是 (2,2)。你的棋子记作「我」，对方的记作「对方」。\n\n下面是当前棋盘（「·」是空位）：\n${boardToText(board)}\n\n【下棋要先想再下】\n· 如果对方已经有任意一条线上两连、且第三格还空着，你必须优先下在那个空格堵住对方。\n· 如果你自己已经两连、且第三格空着，优先下在那里赢下这局。\n· 以上两种情况都没有，就下得自然随意一点，不用追求每一步都最优，可以像朋友一样随手落子，偶尔让一让。\n\n【回复格式】只输出一个 JSON 对象，不要任何额外文字或代码块：\n{"say":"用你自己的口吻说一句正在想的话","x":行,"y":列}\n其中 say 是 8~20 个字的心里话，说说你这一步在想什么；x、y 是落子坐标。${criticalHint}`

  const recent = history.slice(-12).map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    return `${role}：${m.content}`
  }).join('\n')

  const userContent = [{ type: 'text', text: `最近聊天：\n${recent}\n\n现在轮到你落子。` }]
  if (image) userContent.push({ type: 'image_url', image_url: { url: image } })

  const abort = new AbortController()
  req.on('close', () => abort.abort())

  const fallbackMove = (index) => ({
    x: Math.floor(index / 3),
    y: index % 3,
    index,
  })

  try {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.3,
      maxTokens: 160,
      reasoningEffort: 'low',
      signal: abort.signal,
    })) {
      if (isText(chunk)) text += chunk.text
    }
    let move = null
    let say = ''
    try {
      const obj = parseJson(text)
      const x = Number(obj.x)
      const y = Number(obj.y)
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x <= 2 && y >= 0 && y <= 2) {
        const i = x * 3 + y
        if (empty.includes(i)) move = fallbackMove(i)
      }
      if (typeof obj.say === 'string') say = obj.say.trim().slice(0, 60)
    } catch {}
    if (!move) {
      move = fallbackMove(empty[0])
    }
    return sendJson(res, 200, { move, say, fallback: false })
  } catch {
    return sendJson(res, 200, { move: fallbackMove(empty[0]), fallback: true })
  }
}

// 五子棋落子：截图 + 关键威胁提示 + 心声。
async function gomokuMove(ctx, req, res, body) {
  const size = Number(body && body.size) || 15
  if (size < 5 || size > 19) return sendJson(res, 400, { error: 'bad size' })
  const board = Array.isArray(body && body.board) ? body.board : []
  if (board.length !== size * size) return sendJson(res, 400, { error: 'bad board' })

  const empty = []
  for (let i = 0; i < size * size; i++) {
    const v = board[i]
    if (v !== 'user' && v !== 'assistant') empty.push(i)
  }
  if (!empty.length) return sendJson(res, 200, { move: null, gameOver: true })

  const cfg = tune()
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-cfg.historyTurns)
  const { provider, model } = selection(ctx, cfg)
  const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : ''

  // 落子位置由规则引擎决定：保证分得清黑白、该堵会堵、该赢会赢。
  // 小喵只负责「心声」，不负责「算棋」，避免 LLM 在 15×15 上迷失。
  const engineIndex = gomokuBestMove(board, size)
  if (engineIndex < 0) return sendJson(res, 200, { move: null, gameOver: true })

  // 用规则结果来构造提示，让小喵知道这步是赢/堵/普通，说符合情境的话。
  const winMoves = gomokuWinMoves(board, size, 'assistant')
  const blockMoves = gomokuWinMoves(board, size, 'user')
  let situationHint = ''
  if (winMoves.includes(engineIndex)) {
    situationHint = `\n\n【这一步】你刚落下的一子已经连成五子赢了这局。请用你的口吻说一句赢了之后的话。`
  } else if (blockMoves.includes(engineIndex)) {
    situationHint = `\n\n【这一步】你刚刚堵住了对方马上要连成五子的位置。请用你的口吻说一句在堵对方的话。`
  } else {
    situationHint = `\n\n【这一步】这是一步普通的落子。请用你的口吻自然地说一句你在想什么。`
  }

  const system = promptText().replace('{memory}', memoryBlock(memory)) +
    `\n\n你现在正跟朋友下五子棋。棋盘 ${size}×${size}，对方执黑、你执白。你这一步的落子位置已经由规则确定，不需要你计算。\n\n当前棋面摘要（坐标都是「行,列」）：\n${gomokuBoardSummary(board, size)}\n\n你这一步落在：坐标 x=${Math.floor(engineIndex / size)}, y=${engineIndex % size}。\n\n【你的任务只有一件事】用你自己的口吻说一句正在想的话（8~20 个字），配合这一步落子。\n\n只输出一个 JSON 对象，不要任何额外文字或代码块：\n{"say":"你的心里话","x":${Math.floor(engineIndex / size)},"y":${engineIndex % size}}\n其中 x、y 必须原样写上面给的这个坐标，不要自己改。${situationHint}`

  const recent = history.slice(-12).map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    return `${role}：${m.content}`
  }).join('\n')
  const userContent = [{ type: 'text', text: `最近聊天：\n${recent}\n\n现在轮到你落子。` }]
  if (image) userContent.push({ type: 'image_url', image_url: { url: image } })

  const abort = new AbortController()
  req.on('close', () => abort.abort())
  const fallbackMove = (index) => ({ x: Math.floor(index / size), y: index % size, index })
  const engineMove = fallbackMove(engineIndex)

  try {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.3,
      maxTokens: 200,
      reasoningEffort: 'low',
      signal: abort.signal,
    })) {
      if (isText(chunk)) text += chunk.text
    }
    let say = ''
    try {
      const obj = parseJson(text)
      if (typeof obj.say === 'string') say = obj.say.trim().slice(0, 60)
    } catch {}
    return sendJson(res, 200, { move: engineMove, say, fallback: false })
  } catch {
    return sendJson(res, 200, { move: engineMove, say: '', fallback: true })
  }
}

// 游戏出结果时，让小喵知道结果并用自己的口吻说一句收尾话。
// winner：'user'（对方/用户赢）、'assistant'（我赢）、'draw'（平局）。
async function gameOver(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  const kind = body && body.kind === 'gomoku' ? 'gomoku' : 'tictactoe'
  const board = Array.isArray(body && body.board) ? body.board : []
  const size = kind === 'gomoku' ? (Number(body && body.size) || 15) : 3
  if (board.length !== size * size) return sendJson(res, 400, { error: 'bad board' })
  const winner = ['user', 'assistant', 'draw'].includes(body && body.winner) ? body.winner : 'draw'

  const cfg = tune()
  const memory = cleanNotes(body && body.notes)
  const history = normMessages(body && body.messages).slice(-cfg.historyTurns)
  const { provider, model } = selection(ctx, cfg)

  const resultText = winner === 'user'
    ? '对方赢了，你输了'
    : winner === 'assistant'
      ? '你赢了，对方输了'
      : '平局'

  const boardDesc = kind === 'gomoku'
    ? gomokuBoardSummary(board, size)
    : boardToText(board)
  const gameName = kind === 'gomoku' ? '五子棋' : '井字棋'

  const system = promptText().replace('{memory}', memoryBlock(memory)) +
    `\n\n你们刚刚下完了一局${gameName}。结果是：${resultText}。\n\n【你现在只能说这一局棋的收尾话】\n· 必须围绕「这局棋结束了、结果是${resultText}」来说。\n· 赢了别太得意，输了别嘴硬，平局别硬夸。\n· 禁止接之前聊天的内容，禁止谈棋局以外的事，禁止自由发挥、禁止比喻人生、禁止说无关的话。\n· 一句话，8~20 个字。只输出这一句，不要引号、不要前缀。`

  const recent = history.slice(-12).map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    return `${role}：${m.content}`
  }).join('\n')

  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: `最近聊天：\n${recent}\n\n请说一句收尾的话。` }] }],
      temperature: 0.5,
      maxTokens: 80,
      reasoningEffort: 'low',
      signal: abort.signal,
    })) {
      if (isText(chunk)) text += chunk.text
    }
    const say = text.replace(/["'「」]/g, '').trim().slice(0, 80)
    return sendJson(res, 200, { say })
  } catch {
    return sendJson(res, 200, { say: '' })
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
  const history = normRealMessages(body && body.messages).slice(-40)

  if (history.length < 2) return sendJson(res, 200, { notes: memory, updated: false })

  const { provider, model } = extractSelection(tune())
  const tLines = history.map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    const ts = formatTs(m.ts)
    return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`
  })
  const transcript = `现在是 ${formatNow()}。\n${tLines.join('\n')}`
  // 把最近的事件卡也喂给 notes 提取，帮它把具体名字（游戏名/人名等）提进事实层
  const mem = loadMemory()
  const epLines = (mem.episodes || []).slice(-12)
    .map((e) => `${e.theme}（${(e.keywords || []).join('、')}）`)
    .join('\n')
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
            { type: 'text', text: `旧记忆：\n${JSON.stringify(memory)}\n\n最近的事件卡（从中提取具体名字、游戏名、人名）：\n${epLines}\n\n最近的对话：\n${transcript}` },
          ],
        },
      ],
      temperature: 0.3,
      maxTokens: 800,
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
