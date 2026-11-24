import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const ROOT = 'C:/Users/lyy44/Documents/deepseek-harness/default-workspace'
const cfg = JSON.parse(readFileSync(ROOT + '/companion-standalone/config.json', 'utf8'))
const local = existsSync(ROOT + '/companion-standalone/config.local.json')
  ? JSON.parse(readFileSync(ROOT + '/companion-standalone/config.local.json', 'utf8'))
  : {}
const API_KEY = local.apiKey || cfg.apiKey
const BASE = cfg.baseUrl.replace(/\/+$/, '')
const MODEL = cfg.extractModel || 'deepseek-v4-flash'

const memPath = ROOT + '/companion-plugin/data/memory/episodes.json'
const mem = JSON.parse(readFileSync(memPath, 'utf8'))

const SYSTEM = `你是记忆压缩助手。把一天的对话事件归纳成几条精炼的「周归纳」条目。
只输出 JSON 数组，每条形如：
{"theme":"一句话主题","content":"更详细一点的说明","keywords":["词1","词2"]}
规则：
- 合并同类事件，去掉寒暄、调情、重复的。
- theme 10 字以内；content 30 字以内。
- keywords 2~4 个，用于以后检索。
- 输出 8~20 条，宁精勿多。
- 只输出 JSON，不要解释。`

async function summarize(text) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'text', text }] },
    ],
    temperature: 0.3,
    max_tokens: 2000,
    stream: false,
  }
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200))
  const j = await res.json()
  return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : ''
}

for (const w of mem.weekly || []) {
  console.log(`归纳 ${w.day} ... raw ${w.raw.length} 字`)
  const out = await summarize(w.raw)
  try {
    const items = JSON.parse(out.replace(/```[a-z]*/g, '').trim())
    if (Array.isArray(items) && items.length) {
      w.summary = items
      console.log(`  -> ${items.length} 条归纳`)
    }
  } catch (e) {
    console.error(`  ${w.day} 归纳解析失败:`, e.message)
    writeFileSync(`${ROOT}/companion-plugin/data/memory/weekly-${w.day}-RAW.txt`, out, 'utf8')
  }
  await new Promise((r) => setTimeout(r, 500))
}

writeFileSync(memPath, JSON.stringify(mem, null, 2), 'utf8')
console.log('周归纳完成并保存')
