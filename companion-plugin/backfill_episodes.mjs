import { readFileSync, writeFileSync } from 'node:fs'

const THREAD = new URL('data/threads/t-mwfmxywh-0cii.json', import.meta.url)
const EPISODES = new URL('data/memory/episodes.json', import.meta.url)
const standaloneDir = new URL('../companion-standalone/', import.meta.url)

const localCfg = (() => { try { return JSON.parse(readFileSync(new URL('config.local.json', standaloneDir), 'utf8')) } catch { return {} } })()
const srvCfg = (() => { try { return JSON.parse(readFileSync(new URL('config.json', standaloneDir), 'utf8')) } catch { return {} } })()

const BASE_URL = String(srvCfg.baseUrl || '').replace(/\/+$/, '')
const API_KEY = String(localCfg.apiKey || srvCfg.apiKey || '')
const EXTRACT_MODEL = srvCfg.extractModel || 'deepseek-v4-flash'

// 只回填「猫/团子/桌宠/猫娘」这条明确主线，避免「形象/建模」这类泛词把无关讨论也拉进来烧额度
const THEME_WORDS = ['猫团子', '小猫团', '猫团', '桌宠', '猫娘', '电子猫', '电子身体', '实体娃娃', '头箍', '抱枕', '周边', 'vtuber', '皮套']
const EPISODE_WINDOW = 40
const MAX_BATCH = 12

async function extract(text) {
  const sys = readFileSync(new URL('web/episodes.md', import.meta.url), 'utf8')
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: `本段对话：\n${text}` }],
      temperature: 0.3, max_tokens: 2000, stream: false,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const obj = await res.json()
  return String((obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || '')
}

function parseEpisodes(text) {
  let t = String(text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '')
  const i = t.indexOf('[')
  const j = t.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  try { t = t.slice(i, j + 1) } catch { return [] }
  let arr
  try { arr = JSON.parse(t) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr.filter((e) => e && typeof e === 'object').map((e) => ({
    id: 'e-backfill-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    theme: String(e.theme || '').trim().slice(0, 24),
    content: String(e.content || '').trim().slice(0, 60),
    mood: String(e.mood || '').trim().slice(0, 12),
    status: ['done', 'plan', 'idea'].includes(String(e.status || '').trim()) ? String(e.status).trim() : 'done',
    keywords: (Array.isArray(e.keywords) ? e.keywords : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6),
  })).filter((e) => e.theme || e.content)
}

function mergeUnique(existing, incoming) {
  const seen = new Set(existing.map((e) => e.theme + '|' + e.content))
  const out = existing.slice()
  for (const e of incoming) {
    const key = e.theme + '|' + e.content
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

const thread = JSON.parse(readFileSync(THREAD, 'utf8'))
const msgs = (thread.messages || []).filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
const hitIdx = []
msgs.forEach((m, i) => { if (THEME_WORDS.some((w) => (m.content || '').includes(w))) hitIdx.push(i) })
const batches = []
if (hitIdx.length) {
  let start = hitIdx[0]
  for (let i = 1; i < hitIdx.length; i++) {
    if (hitIdx[i] - hitIdx[i - 1] > EPISODE_WINDOW) { batches.push([start, hitIdx[i - 1]]); start = hitIdx[i] }
  }
  batches.push([start, hitIdx[hitIdx.length - 1]])
}

// 跳过单点噪音：只有一句命中、且上下文没别的主题词时，大概率是误命中，不值得烧额度
const meaningful = batches.filter(([from, to]) => {
  const span = msgs.slice(from, to + 1)
  const hitCount = span.filter((m) => THEME_WORDS.some((w) => (m.content || '').includes(w))).length
  return hitCount >= 2 || to - from >= 3
})

console.log(`命中 ${hitIdx.length} 处构想类话题，聚成 ${batches.length} 段，其中有效 ${meaningful.length} 段，最多回填 ${MAX_BATCH} 段`)
let added = 0
for (let b = 0; b < meaningful.length && b < MAX_BATCH; b++) {
  const [from, to] = meaningful[b]
  const chunk = msgs.slice(Math.max(0, from - 3), to + 4)
  const lines = chunk.map((m) => {
    const role = m.role === 'user' ? '对方' : '你'
    const d = m.ts ? new Date(Number(m.ts)) : null
    const ts = d && !isNaN(d) ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''
    return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`
  })
  console.log(`--- 第 ${b + 1}/${Math.min(meaningful.length, MAX_BATCH)} 段：消息 #${from}-${to} (${chunk.length} 条) ---`)
  try {
    const raw = await extract(lines.join('\n'))
    const eps = parseEpisodes(raw)
    console.log(`   提取 ${eps.length} 条：${eps.map((e) => `[${e.status}]${e.theme}`).join(' / ') || '（空）'}`)
    if (!eps.length) continue
    const mem = JSON.parse(readFileSync(EPISODES, 'utf8'))
    mem.episodes = mergeUnique(mem.episodes || [], eps)
    writeFileSync(EPISODES, JSON.stringify(mem), 'utf8')
    added += eps.length
  } catch (err) {
    console.log(`   失败：${String((err && err.message) || err).slice(0, 160)}`)
  }
}
console.log(`\n完成，共新增 ${added} 条事件卡。episodes 现有 ${JSON.parse(readFileSync(EPISODES, 'utf8')).episodes.length} 条。`)
