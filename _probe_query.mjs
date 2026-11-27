// 测四种 tag 组合的查询耗时与体积，找出哪个拖慢
const lat = 29.27, lon = 117.18, r = 800
const cases = [
  ['只 highway', `way["highway"](around:${r},${lat},${lon});`],
  ['只 building', `way["building"](around:${r},${lat},${lon});`],
  ['waterway', `way["waterway"](around:${r},${lat},${lon});`],
  ['bridge(tag)', `way["bridge"](around:${r},${lat},${lon});`],
  ['三类合并', `way["building"](around:${r},${lat},${lon});way["highway"](around:${r},${lat},${lon});way["waterway"](around:${r},${lat},${lon});`],
]

for (const [name, body] of cases) {
  const q = `[out:json][timeout:30];\n(${body});\nout geom;`
  const t0 = Date.now()
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'xiaomiao-companion/1.0 (personal use)',
        Accept: 'application/json',
      },
      body: 'data=' + encodeURIComponent(q),
      signal: AbortSignal.timeout(45000),
    })
    const text = await res.text()
    const ms = Date.now() - t0
    let n = '?'
    try { n = (JSON.parse(text).elements || []).length } catch {}
    console.log(`${name.padEnd(12)} HTTP ${res.status} ${String(ms).padStart(6)}ms ${String(text.length).padStart(7)}B elements=${n}`)
  } catch (e) {
    console.log(`${name.padEnd(12)} 失败 ${Date.now() - t0}ms: ${e.name} ${e.message}`)
  }
}
