// 探测二：浏览器能否直接访问 Overpass（CORS），以及响应体积
const q = `[out:json][timeout:60];
(
  way["building"](around:800,29.2700,117.1800);
  way["highway"](around:800,29.2700,117.1800);
  way["waterway"](around:800,29.2700,117.1800);
);
out geom;`

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'companion-map/1.0 (personal art project)',
    'Accept': 'application/json',
  },
  body: 'data=' + encodeURIComponent(q),
  signal: AbortSignal.timeout(90000),
})
console.log('HTTP', res.status)
console.log('CORS allow-origin:', res.headers.get('access-control-allow-origin'))
const text = await res.text()
console.log('响应体积:', (text.length / 1024).toFixed(1), 'KB')
const obj = JSON.parse(text)
const els = obj.elements || []
const byType = {}
for (const e of els) {
  const t = e.tags || {}
  const k = t.building ? 'building' : t.waterway ? 'waterway' : t.highway ? 'highway' : 'other'
  byType[k] = (byType[k] || 0) + 1
}
console.log('800m 内元素统计:', JSON.stringify(byType))
// 抽查一个建筑，看几何点数
const b = els.find((e) => e.tags && e.tags.building && Array.isArray(e.geometry))
if (b) {
  console.log('样例建筑点数:', b.geometry.length, '首点:', JSON.stringify(b.geometry[0]))
}
