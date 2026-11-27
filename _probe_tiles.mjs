// 探测：免 key 的矢量瓦片服务是否可用（比 Overpass 适合做实时地图）
// 景德镇 29.27,117.18 在 14 级瓦片坐标
const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z)
const lat2tile = (lat, z) => {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}
const z = 14
const x = lon2tile(117.18, z)
const y = lat2tile(29.27, z)
console.log(`z=${z} x=${x} y=${y}`)

const sources = [
  ['OFM 正式瓦片 z14', `https://tiles.openfreemap.org/backup_planet/20261122_124456_pt/${z}/${x}/${y}.pbf`],
  ['OFM 正式瓦片 z13', `https://tiles.openfreemap.org/backup_planet/20261122_124456_pt/13/${lon2tile(117.18, 13)}/${lat2tile(29.27, 13)}.pbf`],
  ['Carto 瓦片', `https://basemaps.cartocdn.com/light_nolabels/${z}/${x}/${y}.png`],
]

for (const [name, url] of sources) {
  try {
    const t0 = Date.now()
    const res = await fetch(url, {
      headers: { 'User-Agent': 'xiaomiao-companion/1.0', 'Accept-Encoding': 'gzip, br' },
      signal: AbortSignal.timeout(25000),
    })
    const buf = Buffer.from(await res.arrayBuffer())
    console.log(`${name.padEnd(14)} HTTP ${res.status} ${String(Date.now() - t0).padStart(6)}ms ${String(buf.length).padStart(8)}B type=${res.headers.get('content-type')} enc=${res.headers.get('content-encoding')}`)
  } catch (e) {
    console.log(`${name.padEnd(16)} 失败: ${e.name} ${e.message}`)
  }
}
