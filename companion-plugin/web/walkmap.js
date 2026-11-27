// 散步纸：一张只有线条的地图，去过的地方才显形。
// 独立的模块，不依赖聊天逻辑；AI 只在需要时读取它写出的摘要。
//
// 设计要点：
//  - 只有 building / highway / waterway 三类，全部用线画，不要填充色块
//  - 河流内部给一层淡水蓝
//  - 米白纸底 + 极淡颗粒
//  - 定位走浏览器 GPS（手机上是真实 GPS，桌面可能不可用）

(() => {
  const INK = '#5a5148'
  const INK_SOFT = 'rgba(90,81,72,0.42)'
  const WATER_LINE = 'rgba(120,150,172,0.60)'
  const WATER_FILL = 'rgba(150,186,206,0.42)'

  const TILES = 'https://tiles.openfreemap.org/backup_planet/20261122_124456_pt/{z}/{x}/{y}.pbf'
  // 默认落点：景德镇，未定位时先有个大致画面
  const HOME = [117.18, 29.27]

  let map = null
  let mapReady = false
  let pendingCenter = null
  let watchId = null
  let lastPos = null
  let meEl = null
  let speedEl = null
  let statusEl = null
  let fogOn = false
  let fogPoints = []

  const makeStyle = () => ({
    version: 8,
    sources: {
      base: { type: 'vector', tiles: [TILES], minzoom: 0, maxzoom: 14 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#f7f2e8' } },

      // 水系：河面/湖面铺淡蓝，再描一道边（用户要求的填充）
      {
        id: 'water-fill', type: 'fill', source: 'base', 'source-layer': 'water',
        paint: { 'fill-color': WATER_FILL, 'fill-outline-color': WATER_LINE },
      },
      {
        id: 'water-line', type: 'line', source: 'base', 'source-layer': 'water',
        paint: { 'line-color': WATER_LINE, 'line-width': 1 },
      },

      // 建筑：只描边，像速写本上的房子轮廓
      {
        id: 'building-outline', type: 'line', source: 'base', 'source-layer': 'building',
        paint: { 'line-color': INK_SOFT, 'line-width': 0.8 },
      },

      // 道路分三级：主路最实，小路最淡
      {
        id: 'road-minor', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'path', 'track']]],
        paint: { 'line-color': 'rgba(90,81,72,0.26)', 'line-width': 0.8 },
      },
      {
        id: 'road-mid', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]],
        paint: { 'line-color': 'rgba(90,81,72,0.42)', 'line-width': 1.3 },
      },
      {
        id: 'road-main', type: 'line', source: 'base', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['primary', 'trunk', 'motorway']]],
        paint: { 'line-color': INK, 'line-width': 2 },
      },
    ],
  })

  function setStatus(text, isErr) {
    if (!statusEl) return
    statusEl.textContent = text
    statusEl.classList.toggle('map-status-error', !!isErr)
  }

  function ensureMap() {
    if (map || typeof maplibregl === 'undefined') return map
    const el = document.getElementById('walkmap')
    if (!el) return null
    map = new maplibregl.Map({
      container: el,
      style: makeStyle(),
      center: HOME,
      zoom: 15,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    })
    map.touchZoomRotate.disableRotation()
    window.__wm = map      // 供诊断
    map.on('load', () => {
      mapReady = true
      // 不覆盖业务提示（迷雾引导语更有用）
      if (fogOn) setStatus(fogPoints.length
        ? '走了 ' + fogPoints.length + ' 处，剩下的还是雾'
        : '一片雾 · 点「◎」定位，走起来才显形')
      else setStatus('已就绪')
      if (pendingCenter) { map.jumpTo({ center: pendingCenter, zoom: 16 }); pendingCenter = null }
      // 地图就绪后才能投影坐标，这时补画一次迷雾
      if (fogOn) { ensureFogCanvas(); if (fogCanvas) fogCanvas.style.display = 'block'; paintFog() }
      drawMe()
    })
    map.on('error', (e) => {
      const msg = (e && e.error && e.error.message) || '地图加载失败'
      setStatus(String(msg).slice(0, 30), true)
    })
    map.on('move', drawMe)
    map.on('zoom', drawMe)
    // 地图一动，迷雾的洞也要跟着地形走
    map.on('move', scheduleFog)
    map.on('zoom', scheduleFog)
    return map
  }

  function drawMe() {
    if (!meEl) meEl = document.getElementById('walkmap-me')
    if (!map || !meEl) return
    if (!lastPos) { meEl.hidden = true; return }
    // 用容器内相对坐标，跟着地图移动
    const p = map.project(lastPos)
    meEl.hidden = false
    meEl.style.left = p.x + 'px'
    meEl.style.top = p.y + 'px'
  }

  // 本机/手机真实定位
  function locate() {
    if (!ensureMap()) { setStatus('地图未就绪', true); return }
    if (!navigator.geolocation) { setStatus('浏览器不支持定位', true); return }
    setStatus('正在定位…')
    navigator.geolocation.getCurrentPosition(
      (pos) => onPosition(pos, true),
      (err) => {
        // 桌面浏览器的定位常因网络服务不可达而失败，明确告诉用户原因
        const reason = /network/i.test(err.message || '') ? '定位服务不可用（手机上用GPS正常）' : (err.message || '定位失败')
        setStatus(reason, true)
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 3000 },
    )
    if (watchId == null) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => onPosition(pos, false),
        () => {},
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
      )
    }
  }

  function onPosition(pos, recenter) {
    const { longitude, latitude, speed, accuracy } = pos.coords
    lastPos = [longitude, latitude]
    if (speedEl) {
      speedEl.textContent = (speed != null && speed >= 0) ? (speed * 3.6).toFixed(1) + ' km/h' : '静止'
    }
    setStatus(`精度 ±${Math.round(accuracy)}m`)
    if (!map) { pendingCenter = lastPos; return }
    if (recenter && mapReady) {
      map.easeTo({ center: lastPos, zoom: 16, duration: 800 })
    }
    // 记录轨迹点，供迷雾用
    recordPoint(lastPos)
    if (fogOn) scheduleFog()
    drawMe()
  }

  // 只在移动了足够远时才记点，避免站着不动刷出成千上万个点
  const MIN_STEP_M = 8
  function recordPoint(p) {
    const prev = fogPoints[fogPoints.length - 1]
    if (prev) {
      const dLat = (p[1] - prev[1]) * 111320
      const dLon = (p[0] - prev[0]) * 111320 * Math.cos((p[1] * Math.PI) / 180)
      if (Math.hypot(dLat, dLon) < MIN_STEP_M) return
    }
    fogPoints.push(p)
    saveTrail()
  }

  // ---------- 真迷雾 ----------
  // 做法：整张纸盖一层不透明「纸」，然后在你走过的位置把纸擦掉（destination-out）。
  // 这样没去过的地方就是一片纸白，只有走过的路会露出下面的地形线。
  //
  // 用 Canvas 2D 而不是地图图层：地图是 WebGL，画洞很麻烦；Canvas 的合成模式刚好合适。
  const FOG_RADIUS_M = 55       // 每走一个点，擦开半径 55 米（约一个人能看清周围的范围）
  let fogCanvas = null
  let fogCtx = null
  let fogRaf = 0

  function ensureFogCanvas() {
    if (fogCanvas) return fogCanvas
    const paper = document.querySelector('.map-paper')
    if (!paper) return null
    fogCanvas = document.createElement('canvas')
    fogCanvas.className = 'walkmap-fog'
    // 放在纸纹下方、地图上方
    paper.insertBefore(fogCanvas, paper.querySelector('.map-grain'))
    fogCtx = fogCanvas.getContext('2d')
    return fogCanvas
  }

  function sizeFogCanvas() {
    if (!fogCanvas || !map) return
    const rect = map.getContainer().getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (fogCanvas.width !== w || fogCanvas.height !== h) {
      fogCanvas.width = w
      fogCanvas.height = h
      fogCanvas.style.width = rect.width + 'px'
      fogCanvas.style.height = rect.height + 'px'
    }
  }

  // 每米对应多少像素（随缩放变化）
  function metersPerPixel() {
    const lat = map.getCenter().lat
    return 156543.03392 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, map.getZoom())
  }

  function paintFog() {
    if (!fogOn || !fogCanvas || !fogCtx || !map) return
    sizeFogCanvas()
    const ctx = fogCtx
    const w = fogCanvas.width
    const h = fogCanvas.height
    const dpr = w / Math.max(1, fogCanvas.clientWidth)

    // 1. 整张铺雾。
    //    不是完全不透明的纸：留一点点通透感，能隐约看见下面地形的轮廓，
    //    像隔着毛玻璃看一张没画完的地图——那是「未知」而不是「空白」。
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, w, h)
    // 0.86：雾里还能隐隐看到地形线，不是一片死白
    ctx.fillStyle = 'rgba(243,236,222,0.86)'
    ctx.fillRect(0, 0, w, h)

    // 1.5 雾面质感：叠一层极淡的斑驳，避免整片死平
    ctx.save()
    ctx.globalAlpha = 0.5
    const grd = ctx.createRadialGradient(w * 0.28, h * 0.22, 0, w * 0.28, h * 0.22, Math.max(w, h) * 0.9)
    grd.addColorStop(0, 'rgba(255,253,247,0.45)')
    grd.addColorStop(0.55, 'rgba(240,232,218,0.10)')
    grd.addColorStop(1, 'rgba(226,216,200,0.30)')
    ctx.fillStyle = grd
    ctx.fillRect(0, 0, w, h)

    // 1.6 几团更浓的雾：让它看起来像浮着的云雾，而不是一层均匀的膜。
    //     位置用固定种子算，每次重绘都一样，不会闪。
    const seedBase = fogPoints.length ? fogPoints[0] : [117.18, 29.27]
    let seed = Math.abs(Math.sin(seedBase[0] * 12.9898 + seedBase[1] * 78.233) * 43758.5453)
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 }
    ctx.globalAlpha = 1
    for (let i = 0; i < 5; i++) {
      const cx = rnd() * w
      const cy = rnd() * h
      const rr = (0.35 + rnd() * 0.5) * Math.max(w, h)
      const cl = ctx.createRadialGradient(cx, cy, rr * 0.15, cx, cy, rr)
      cl.addColorStop(0, 'rgba(236,228,212,0.55)')
      cl.addColorStop(0.6, 'rgba(238,230,215,0.22)')
      cl.addColorStop(1, 'rgba(240,233,220,0)')
      ctx.fillStyle = cl
      ctx.beginPath()
      ctx.arc(cx, cy, rr, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    // 2. 把走过的位置擦出洞
    const radPx = (FOG_RADIUS_M / metersPerPixel()) * dpr
    ctx.globalCompositeOperation = 'destination-out'
    for (const p of fogPoints) {
      const pt = map.project(p)
      const x = pt.x * dpr
      const y = pt.y * dpr
      // 圆外再放一圈渐隐，让边界不像硬切的一张纸
      const g = ctx.createRadialGradient(x, y, radPx * 0.72, x, y, radPx)
      g.addColorStop(0, 'rgba(0,0,0,1)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, radPx, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  // 地图动一下就重画（合并到下一帧，避免卡顿）
  function scheduleFog() {
    if (!fogOn) return
    if (fogRaf) return
    fogRaf = requestAnimationFrame(() => {
      fogRaf = 0
      paintFog()
    })
  }

  // ---------- 走过的点：存本地，刷新不丢 ----------
  const STORE_KEY = 'walkmap.trail.v1'
  function loadTrail() {
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (!raw) return
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        fogPoints = arr.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
      }
    } catch {}
  }
  let saveTimer = 0
  function saveTrail() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        // 只留最近 3000 个点，避免无限增长
        if (fogPoints.length > 3000) fogPoints = fogPoints.slice(-3000)
        localStorage.setItem(STORE_KEY, JSON.stringify(fogPoints))
      } catch {}
    }, 1200)
  }

  // setFog(true/false)：统一入口，默认开启和手动切换都走这里
  function setFog(on, opts = {}) {
    fogOn = !!on
    if (fogOn) {
      ensureFogCanvas()
      if (fogCanvas) fogCanvas.style.display = 'block'
      paintFog()
      if (!opts.silent) {
        setStatus(fogPoints.length
          ? '走了 ' + fogPoints.length + ' 处，剩下的还是雾'
          : '一片雾，走起来才显形')
      }
    } else {
      if (fogCanvas) fogCanvas.style.display = 'none'
      if (!opts.silent) setStatus('已揭开全部')
    }
    const btn = document.getElementById('map-fog')
    if (btn) btn.classList.toggle('on', fogOn)
  }
  function toggleFog() { setFog(!fogOn) }

  // 侧栏切成「散步纸」时才初始化地图（省手机流量和内存）
  window.WalkMap = {
    activate() {
      meEl = document.getElementById('walkmap-me')
      speedEl = document.getElementById('map-speed')
      statusEl = document.getElementById('map-status')
      loadTrail()
      const btn = document.getElementById('map-locate')
      if (btn && !btn.dataset.bound) {
        btn.dataset.bound = '1'
        btn.addEventListener('click', locate)
      }
      const fog = document.getElementById('map-fog')
      if (fog && !fog.dataset.bound) {
        fog.dataset.bound = '1'
        fog.addEventListener('click', toggleFog)
      }
      // 等容器有尺寸再建图，否则 canvas 会 0 宽
      requestAnimationFrame(() => {
        const m = ensureMap()
        if (m) setTimeout(() => {
          try { m.resize() } catch {}
          // 默认就进入迷雾：先给一片雾，走起来才慢慢显形
          setFog(true, { silent: true })
          setStatus(fogPoints.length
            ? '走了 ' + fogPoints.length + ' 处，剩下的还是雾'
            : '一片雾 · 点「◎」定位，走起来才显形')
        }, 60)
      })
    },
    // 给聊天/记忆用的小摘要
    summary() {
      if (!lastPos) return ''
      const [lon, lat] = lastPos
      return `我在 ${lat.toFixed(4)},${lon.toFixed(4)} 附近，今天走过 ${fogPoints.length} 个记录点。`
    },
  }
})()
