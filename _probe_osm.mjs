// 一次性探测：确认景德镇周边 OSM 数据密度够不够画简笔画式地形
const tags = ['building', 'highway', 'waterway', 'bridge']
const q = tags.map((t) => `way["${t}"](around:2000,29.2700,117.1800);out count;`).join('\n')

const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

for (const url of endpoints) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'companion-map-probe/1.0',
      },
      body: 'data=' + encodeURIComponent(q),
      signal: AbortSignal.timeout(90000),
    })
    const text = await res.text()
    if (res.ok) {
      // 兼容 JSON 与 XML 两种返回
      const counts = /<count/.test(text)
        ? [...text.matchAll(/<tag k="ways" v="(\d+)"\/>/g)].map((m) => m[1])
        : [...text.matchAll(/"ways"\s*:\s*"?(\d+)"?/g)].map((m) => m[1])
      const names = tags.map((t, i) => `${t}=${counts[i] ?? '?'}`)
      console.log(url, '=> HTTP', res.status)
      console.log('2km 内 各类型 way 数量：', names.join('  '))
      console.log('原始:', text.replace(/\s+/g, ' ').slice(0, 600))
      break
    } else {
      console.log(url, '=> HTTP', res.status, text.slice(0, 160))
    }
  } catch (e) {
    console.log(url, '=>', e.name, e.message)
  }
}
