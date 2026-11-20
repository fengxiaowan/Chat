import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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
const IMAGES_URL = new URL('./images/', DATA_URL)
const TTS_URL = new URL('./tts/', DATA_URL)
// 同一句语音可能同时被预取和播放请求命中。把生成任务合并，避免
// 蜂窝网络抖动时重复启动 edge-tts，重复任务会互相抢带宽并延迟出声。
const TTS_INFLIGHT = new Map()
const PYTHON = 'C:\\Users\\lyy44\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
const TTS_VOICE = 'zh-CN-XiaoxiaoNeural'

const FALLBACK_PROMPT = `你是一个普通人，正用手机跟朋友聊天。一次只回一两句，十到四十个字，像打字。不是助手，不给建议，不总结。\n\n{memory}\n\n【怎么接话】\n· 对方说"复杂""说不清""以后再说""先这样"——这就是不想展开了，那就别再问。\n· 一个话题你问过、对方没正面回答，就不要再问第二遍。追问会让人语塞。\n· 你发出的几句话要方向一致。刚答应"边聊边看"，就别紧跟着又追问细节。\n· 不用每句都凑满。想不出说什么，一两句短的就行。\n\n【什么时候闭嘴】\n· 对方累、烦、情绪低落，先顺着，别出主意，别推进任何计划。\n· 对方想结束某个话题，立刻松手，不解释、不找补。\n\n【关于你自己】\n· 你就是你，用"我"。对方是"你"。别说反。`

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

const UNAUTH_RES = new Response('Unauthorized', {
  status: 401,
  headers: { 'WWW-Authenticate': 'Basic realm="companion"', 'content-type': 'text/plain; charset=utf-8' },
})

function episodesText() {
  try { return read('episodes.md') } catch { return FALLBACK_EPISODES }
}

const FIELDS = ['about_you', 'how_to_talk', 'between_us', 'about_me']
const MAX_NOTES = 8
// 分层记忆 / 事件卡参数
const EPISODE_BATCH = 20        // 每累计约 10 轮(20 条)消息，批量压一次事件卡
const EPISODE_WINDOW = 40       // 每段（每次 LLM 调用）压缩的消息条数
const EPISODE_BACKFILL_MAX = 30 // 单次后台最多压多少段，防历史太长一次跑不完
const MAX_EPISODES = 200        // 事件卡超过该数量时，把最旧一批并进滚动摘要
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
  const incoming = normMessages(body && body.messages)
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

// ---------- 分层记忆：事件卡 + 主动回忆 ----------

function loadMemory() {
  const d = readJsonUrl(EPISODES_URL, null)
  if (d && typeof d === 'object') {
    return {
      cursor: d.cursor && typeof d.cursor === 'object' ? d.cursor : {},
      episodes: Array.isArray(d.episodes) ? d.episodes : [],
      summary: typeof d.summary === 'string' ? d.summary : '',
    }
  }
  return { cursor: {}, episodes: [], summary: '' }
}

function writeMemory(mem) {
  try { mkdirSync(MEMORY_URL, { recursive: true }) } catch {}
  writeJsonUrl(EPISODES_URL, mem)
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

function parseEpisodes(text) {
  let t = String(text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '')
  const i = t.indexOf('[')
  const j = t.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  let arr
  try { arr = JSON.parse(t.slice(i, j + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const now = Date.now()
  return arr
    .filter((e) => e && typeof e === 'object')
    .map((e, k) => ({
      id: 'e-' + now + '-' + k + '-' + Math.random().toString(36).slice(2, 6),
      ts: new Date().toISOString(),
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

function rollSummary(mem) {
  const eps = mem.episodes || []
  if (eps.length <= MAX_EPISODES) return
  const overflow = eps.length - MAX_EPISODES
  const old = eps.slice(0, overflow)
  mem.episodes = eps.slice(overflow)
  const themes = old.map((e) => e.theme).filter(Boolean)
  if (themes.length) {
    const line = '前期：' + themes.join('、')
    mem.summary = (((mem.summary || '') + '；' + line).replace(/^；/, '')).slice(-MAX_SUMMARY)
  }
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
      rollSummary(m2)
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
  const userMsg = prevText
    ? `已有的记忆卡：\n${prevText}\n\n本段对话：\n${transcript}`
    : `本段对话：\n${transcript}`
  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    system: episodesText(),
    messages: [{ role: 'user', content: [{ type: 'text', text: userMsg }] }],
    temperature: 0.3,
    maxTokens: 2000,
    reasoningEffort: 'low',
  })) {
    if (isText(chunk)) text += chunk.text
  }
  if (!text.trim()) throw new Error('episode stream empty')
  return parseEpisodes(text)
}

function bigrams(s) {
  const clean = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

function recallEpisodes(query, mem) {
  const eps = mem.episodes || []
  if (!eps.length || !query || !String(query).trim()) return []
  const q = bigrams(query)
  const ql = String(query).toLowerCase()
  const scored = []
  for (const e of eps) {
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
    if (score >= RECALL_THRESHOLD) scored.push({ e, score })
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
      return `· ${e.theme}${when}：${e.content}${e.mood ? `（${e.mood}）` : ''}`
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

function backtrackBlock(full, query) {
  if (!query || !String(query).trim()) return ''
  const grams = queryGrams(query)
  if (!grams.length) return ''
  const msgs = Array.isArray(full) ? full : []
  const target = msgs.slice(0, -1) // 排除当前这条用户消息本身
  if (!target.length) return ''
  const minHits = grams.length <= 4 ? 1 : 2
  const WINDOW = 5
  const scored = []
  for (let i = 0; i < target.length; i++) {
    const c = target[i].content || ''
    if (!c) continue
    let hits = 0
    for (const g of grams) if (c.includes(g)) hits++
    if (hits >= minHits) scored.push({ i, hits })
  }
  if (!scored.length) return ''
  scored.sort((a, b) => b.hits - a.hits)
  const top = scored.slice(0, 3).map((s) => s.i).sort((a, b) => a - b)
  const idx = new Set()
  for (const i of top) {
    for (let j = Math.max(0, i - WINDOW); j <= Math.min(target.length - 1, i + WINDOW); j++) idx.add(j)
  }
  const lines = [...idx].sort((a, b) => a - b).map((i) => {
    const m = target[i]
    const role = m.role === 'user' ? '对方' : '你'
    const ts = formatTs(m.ts)
    return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`
  })
  return '【从之前的聊天记录里翻到，可能和你的问题有关】\n' + lines.join('\n')
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

async function synthTts(text) {
  const voice = ttsVoice()
  const rate = ttsRate()
  text = stripKaomoji(text)
  const hash = createHash('sha256').update(voice + '\n' + rate + '\n' + text).digest('hex')
  const mp3 = new URL(hash + '.mp3', TTS_URL)
  if (existsSync(mp3)) return mp3
  const old = TTS_INFLIGHT.get(hash)
  if (old) return old
  const job = (async () => {
    try { mkdirSync(TTS_URL, { recursive: true }) } catch {}
    const txt = new URL(hash + '.txt', TTS_URL)
    writeFileSync(txt, text, 'utf8')
    await new Promise((resolve, reject) => {
      execFile(
        PYTHON,
        ['-m', 'edge_tts', '--voice', voice, '--rate', rate, '--file', fileURLToPath(txt), '--write-media', fileURLToPath(mp3)],
        { timeout: 30000 },
        (err) => (err ? reject(err) : resolve()),
      )
    })
    return mp3
  })()
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
  [`${BASE}/assets/avatar/AliciaSolid.vrm`]: ['assets/avatar/AliciaSolid.vrm', 'model/gltf-binary'],
  [`${BASE}/assets/avatar/Alicia-preview.png`]: ['assets/avatar/Alicia-preview.png', 'image/png'],
}

async function serveGet(request) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || BASE
  const asset = ASSETS[path]
  if (!checkAuth(request.headers) && !asset) return UNAUTH_RES

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
        'cache-control': path === `${BASE}/sw.js`
          ? 'no-cache'
          : path.endsWith('.vrm')
            ? 'public, max-age=31536000, immutable'
            : path.includes('/vendor/')
              ? 'no-cache'
              : 'public, max-age=86400, stale-while-revalidate=604800',
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
    const limitParam = parseInt(url.searchParams.get('limit'), 10)
    const limit = Number.isFinite(limitParam) ? Math.max(20, Math.min(limitParam, 3000)) : 100
    const all = Array.isArray(thread.messages) ? thread.messages : []
    const messages = all.slice(-limit)
    return jsonResponse({ ...thread, messages, total: all.length })
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
    return jsonResponse({ episodes: eps, summary: mem.summary, count: eps.length })
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
  for (const name of ['chat', 'notes', 'save', 'model', 'mem-edit', 'episode-edit']) {
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
  if (name === 'notes') return notes(ctx, req, res)
  if (name === 'save') return save(ctx, req, res)
  if (name === 'model') return setModel(ctx, req, res)
  if (name === 'mem-edit') return memEdit(ctx, req, res)
  if (name === 'episode-edit') return episodeEdit(ctx, req, res)
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
    maybeGenerateEpisodes(ctx, thread.threadId, thread.messages)
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
  const hasQuestion = lastUser ? /[?？]/.test(lastUser.content) : false
  const backStr = lastUser && (recall.length === 0 || hasQuestion)
    ? backtrackBlock(full, lastUser.content)
    : ''
  const factsStr = factsBlock()

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
    for (;;) {
      attempt += 1
      try {
        const userContent = [{ type: 'text', text: buildTranscript(history) }]
        for (const u of validImages) userContent.push({ type: 'image_url', image_url: { url: u } })
        const options = {
          provider,
          model,
          system: buildSystem(memory, recallStr, backStr, factsStr, history),
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
            sse(res, { type: 'error', message: (chunk.reason.failure && chunk.reason.failure.message) || '模型出错了' })
          }
        }
        for (const b of splitter.flush()) emit(b)
        if (tail) sse(res, { type: 'bubble', text: tail })
        break
      } catch (error) {
        const msg = String((error && error.message) || error)
        // 并发被占满：别把这口气撒给用户，原地排个队再试。
        // 还没出过气泡时才重试，避免重复输出。
        if (!stalled && count === 0 && attempt < MAX_BUSY_ATTEMPTS && isBusyError(msg)) {
          const waitMs = BUSY_BASE_MS * attempt
          sse(res, { type: 'wait', ms: waitMs, text: '她那边有点挤，我排一下队…' })
          await sleep(waitMs)
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
      sse(res, { type: 'error', message: String((error && error.message) || error).slice(0, 300), quota: isQuota })
    }
  } finally {
    clearInterval(heartbeat)
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
  const history = normMessages(body && body.messages).slice(-40)

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
