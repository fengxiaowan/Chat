import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const ROOT = 'C:/Users/lyy44/Documents/deepseek-harness/default-workspace'
const cfg = JSON.parse(readFileSync(ROOT + '/companion-standalone/config.json', 'utf8'))
const local = existsSync(ROOT + '/companion-standalone/config.local.json')
  ? JSON.parse(readFileSync(ROOT + '/companion-standalone/config.local.json', 'utf8'))
  : {}
const API_KEY = local.apiKey || cfg.apiKey
const BASE = cfg.baseUrl.replace(/\/+$/, '')
const MODEL = cfg.extractModel || 'deepseek-v4-flash'

const lines = readFileSync(ROOT + '/companion-plugin/data/memory/user-msgs-20261124.txt', 'utf8').split('\n')

const SYSTEM = `你是记忆整理助手。从对话中提炼「关于这位用户」的长期事实词条。

只输出 JSON 数组，每个元素形如：
{"key":"关键词","facts":["事实1","事实2"],"sensitive":false}

规则：
- 只记用户真实说过、真实存在的长期事实：身份、住址、技能、经历、喜好、习惯、重要关系、重要物品。
- 不记一次性的情绪、流水账、哲学讨论、寒暄、调情。
- facts 每条 20 字以内，用第三人称客观描述，不要抒情。
- 相同主题合并到同一个 key 下；同一事实不要重复出现。
- 涉及去世的宠物、创伤、隐私等，sensitive 设为 true。
- 没有可记的就输出空数组 []。
- 只输出 JSON，不要解释。`

async function extract(batchText) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'text', text: batchText }] },
    ],
    temperature: 0.2,
    max_tokens: 3000,
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

const BATCH = 200
const nBatches = Math.ceil(lines.length / BATCH)
const all = []
for (let i = 0; i < nBatches; i++) {
  const chunk = lines.slice(i * BATCH, (i + 1) * BATCH).join('\n')
  console.log(`提取批次 ${i + 1}/${nBatches} ...`)
  const out = await extract(chunk)
  try {
    const json = JSON.parse(out.replace(/```[a-z]*/g, '').trim())
    if (Array.isArray(json)) all.push(...json)
  } catch (e) {
    console.error(`批次 ${i + 1} 解析失败:`, e.message)
    writeFileSync(`${ROOT}/companion-plugin/data/memory/l0-batch-${i + 1}-RAW.txt`, out, 'utf8')
  }
  await new Promise(r => setTimeout(r, 500))
}

// 合并去重：同 key 合并 facts，同 fact 去重
const map = new Map()
for (const item of all) {
  if (!item || typeof item.key !== 'string' || !Array.isArray(item.facts)) continue
  const key = item.key.trim()
  if (!key) continue
  if (!map.has(key)) map.set(key, { key, facts: [], sensitive: false })
  const entry = map.get(key)
  for (const f of item.facts) {
    const s = String(f).trim()
    if (s && !entry.facts.includes(s)) entry.facts.push(s)
  }
  if (item.sensitive) entry.sensitive = true
}
const result = [...map.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh'))
writeFileSync(ROOT + '/companion-plugin/data/memory/l0-facts.json', JSON.stringify(result, null, 2), 'utf8')
console.log('=== 合并完成 ===')
console.log('词条数:', result.length)
console.log('总 facts 数:', result.reduce((n, x) => n + x.facts.length, 0))
