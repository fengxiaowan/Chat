// 探测一：OSM 国内数据用的是 WGS84 还是 GCJ-02（两者在中国偏移可达数百米）
// 做法：拉景德镇一小片道路+建筑，和已知地标比对。
// 先确认数据里有可识别的命名地标，才能判断。
const q = `[out:json][timeout:60];
(
  way["highway"]["name"](around:1200,29.2700,117.1800);
);
out tags 40;`

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'companion-map-probe/1.0',
  },
  body: 'data=' + encodeURIComponent(q),
  signal: AbortSignal.timeout(90000),
})
console.log('HTTP', res.status)
const text = await res.text()
let obj
try { obj = JSON.parse(text) } catch {
  console.log('非 JSON，前 300 字：', text.slice(0, 300))
  process.exit(0)
}
const els = obj.elements || []
console.log('带名字的道路数：', els.length)
const seen = new Set()
for (const e of els) {
  const n = e.tags && e.tags.name
  if (!n || seen.has(n)) continue
  seen.add(n)
  console.log('  ', n, '|', e.tags.highway, '| center:', JSON.stringify(e.center || null))
  if (seen.size >= 12) break
}
