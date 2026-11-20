(() => {
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const input = $('input');
  const sendBtn = $('send');

  // 折叠 / 展开形象面板
  const layout = $('companion-layout');
  const collapseBtn = $('avatar-collapse');
  const COLLAPSE_KEY = 'companion.avatarCollapsed.v1';
  if (layout && collapseBtn) {
    // 恢复上次的折叠状态
    if (localStorage.getItem(COLLAPSE_KEY) === '1') layout.classList.add('collapsed');
    const expandBtn0 = $('avatar-expand');
    if (expandBtn0) expandBtn0.hidden = localStorage.getItem(COLLAPSE_KEY) !== '1';
    collapseBtn.addEventListener('click', () => {
      const collapsed = layout.classList.toggle('collapsed');
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
      collapseBtn.title = collapsed ? '展开形象' : '收起形象';
      const expandBtn = $('avatar-expand');
      if (expandBtn) expandBtn.hidden = !collapsed;
    });
    const expandBtn = $('avatar-expand');
    if (expandBtn) expandBtn.addEventListener('click', () => collapseBtn.click());
  }

  const BASE = '/liao';
  const LS = {
    hist: 'companion.history.v3',
    notes: 'companion.notes.v4',
    thread: 'companion.thread.v1',
  };
  const EMPTY_NOTES = { about_you: [], how_to_talk: [], between_us: [], about_me: [] };
  // 本地缓存多少条：够翻一段历史，又不至于把 localStorage 撑爆
  const CACHE_MAX = 600;

  const S = {
    history: [],
    notes: normalizeNotes(EMPTY_NOTES),
    threadId: '',
    title: '',
    limit: 26,
    model: '',
    gen: 0,
    queue: [],
    idx: 0,
    done: true,
    wake: null,
    typing: null,
    notesBusy: false,
  };
  let ctrl = null;
  let saveTimer = null;

  function read(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch { return d; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }
  function normalizeNotes(n) {
    const out = {};
    for (const k of Object.keys(EMPTY_NOTES)) {
      out[k] = Array.isArray(n && n[k]) ? n[k].filter((x) => typeof x === 'string') : [];
    }
    return out;
  }
  // 两个设备各自的本地记录取并集，避免后保存的一方覆盖另一方
  function mergeMessages(server, local) {
    const seen = new Set();
    const out = [];
    for (const m of (Array.isArray(server) ? server : [])) {
      const key = (m && m.ts || '') + '|' + (m && m.role) + '|' + (m && m.content);
      seen.add(key);
      out.push(m);
    }
    for (const m of (Array.isArray(local) ? local : [])) {
      const key = (m && m.ts || '') + '|' + (m && m.role) + '|' + (m && m.content);
      if (!seen.has(key)) { seen.add(key); out.push(m); }
    }
    // 服务器只返回最近一段时，本地更老的消息会被拼到后面；按时间戳重新排好
    out.sort((a, b) => (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0));
    return out;
  }
  const newId = () => 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const titleOf = (h) => {
    const first = (h || []).find((m) => m.role === 'user');
    return first ? first.content.slice(0, 20) : '未命名';
  };

  // ---------- 视图 ----------
  function scrollBottom() {
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  // 图片是异步加载的，加载完会把内容撑高；只要用户没往上翻，就一直贴在底部
  let followBottom = true;
  let lastScrollTop = 0;
  list.addEventListener('scroll', () => {
    const t = list.scrollTop;
    if (t < lastScrollTop - 4) followBottom = false;
    else if (t > lastScrollTop + 4) followBottom = true;
    lastScrollTop = t;
  });
  function keepBottom() {
    if (followBottom) scrollBottom();
  }
  function setStatus(text, typing) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('typing', !!typing);
  }
  function avatarState(state) {
    window.dispatchEvent(new CustomEvent('companion-avatar', { detail: { state } }));
  }
  let ttsAudio = null;
  let playingEl = null;
  let playEndCb = null;
  let ttsQueue = [];
  let ttsQueueActive = false;
  let autoPlay = read('companion.autoplay', false);

  // ---------- 语音预取 ----------
  // 目的：气泡还在「逐字打」的同时就把语音生成好，出声不用再等 1.2~1.6 秒。
  // 做法：拿到一句文本立刻发起请求，把 blob 存进 ttsPrefetch，播放时直接用。
  const ttsPrefetch = new Map();
  // 串行预取队列：手机走蜂窝/Tailscale 时并发打满会互相拖累、也更容易断，
  // 改成同一时刻最多一个在途请求，一条条稳稳拿。
  let ttsPrefetchBusy = false;
  const ttsPrefetchQueue = [];
  function drainTtsPrefetch() {
    if (ttsPrefetchBusy) return;
    const job = ttsPrefetchQueue.shift();
    if (!job) return;
    ttsPrefetchBusy = true;
    const { key } = job;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const url = BASE + '/tts?text=' + encodeURIComponent(key);
      fetch(url, { credentials: 'same-origin', signal: ctl.signal })
        .then((r) => (r.ok ? r.blob() : null))
        .then((blob) => {
          if (blob && blob.size > 0) {
            ttsPrefetch.set(key, URL.createObjectURL(blob));
            // 防止无限增长：超过 60 条就丢掉最早的
            if (ttsPrefetch.size > 60) {
              for (const [k, v] of ttsPrefetch) {
                if (ttsPrefetch.size <= 45) break;
                if (typeof v === 'string') URL.revokeObjectURL(v);
                ttsPrefetch.delete(k);
              }
            }
          } else {
            ttsPrefetch.delete(key);
          }
        })
        .catch(() => { ttsPrefetch.delete(key); })
        .finally(() => {
          clearTimeout(timer);
          ttsPrefetchBusy = false;
          drainTtsPrefetch();
          kickPump();
        });
    } catch { clearTimeout(timer); ttsPrefetch.delete(key); ttsPrefetchBusy = false; drainTtsPrefetch(); }
  }
  function prefetchTts(text) {
    const key = String(text || '').trim();
    if (!key || ttsPrefetch.has(key)) return;
    ttsPrefetch.set(key, null); // 占位，避免重复请求
    ttsPrefetchQueue.push({ key });
    drainTtsPrefetch();
  }

  // 单例 audio：解锁一次，之后换 src 复用（新 Audio 每次都会被拦）
  function getAudio() {
    if (!ttsAudio) {
      ttsAudio = document.createElement('audio');
      ttsAudio.preload = 'auto';
      ttsAudio.addEventListener('ended', () => finishPlay());
      ttsAudio.addEventListener('error', () => finishPlay());
    }
    return ttsAudio;
  }
  function finishPlay() {
    if (playingEl) playingEl.classList.remove('playing');
    playingEl = null;
    avatarState('idle');
    const cb = playEndCb;
    playEndCb = null;
    if (cb) cb();
  }
  // 在用户手势里先播一次静音，解锁自动播放
  function unlockAudio() {
    try {
      const a = getAudio();
      if (!a.paused) return;
      a.muted = true;
      a.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      const p = a.play();
      const done = () => { try { a.pause(); } catch {} a.muted = false; };
      if (p && p.then) p.then(done).catch(() => { a.muted = false; });
      else done();
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  document.addEventListener('touchstart', unlockAudio, { once: true });

  function stopAllTts() {
    try { getAudio().pause(); } catch {}
    ttsQueue = [];
    if (playingEl) playingEl.classList.remove('playing');
    playingEl = null;
    playEndCb = null;
    avatarState('idle');
  }
  function playOne(text, bubbleEl, onEnd) {
    const a = getAudio();
    try { a.pause(); } catch {}
    if (playingEl) playingEl.classList.remove('playing');
    playingEl = bubbleEl || null;
    if (playingEl) playingEl.classList.add('playing');
    playEndCb = onEnd || null;
    avatarState('speaking');
    a.muted = false;
    const key = String(text || '').trim();
    const ready = ttsPrefetch.get(key);
    if (typeof ready === 'string') {
      // 预取好了：本地 blob，零网络等待
      a.src = ready;
      a.play().catch(() => { finishPlay(); });
      return;
    }
    // 还没预取完，先等它（此时通常只差一点点）
    if (ttsPrefetch.has(key)) {
      waitPrefetch(key, (blobUrl) => {
        if (playingEl !== (bubbleEl || null)) return; // 期间被停掉了
        if (blobUrl) {
          a.src = blobUrl;
          a.play().catch(() => { finishPlay(); });
        } else {
          a.src = BASE + '/tts?text=' + encodeURIComponent(key);
          a.play().catch(() => { finishPlay(); });
        }
      });
      return;
    }
    a.src = BASE + '/tts?text=' + encodeURIComponent(key);
    a.play().catch(() => { finishPlay(); });
  }
  // 等某句的预取结果（最多等 8 秒，超时就用普通请求）
  function waitPrefetch(key, cb) {
    const t0 = Date.now();
    const tick = () => {
      const v = ttsPrefetch.get(key);
      if (typeof v === 'string') return cb(v);
      if (!ttsPrefetch.has(key)) return cb(null);
      if (Date.now() - t0 > 8000) return cb(null);
      setTimeout(tick, 60);
    };
    tick();
  }
  function toggleBubble(text, bubbleEl) {
    if (playingEl === bubbleEl && ttsAudio && !ttsAudio.paused) {
      stopAllTts();
    } else {
      stopAllTts();
      prefetchTts(text);   // 手动点读也走预取（多半已缓存，只剩 2ms）
      playOne(text, bubbleEl);
    }
  }
  function enqueueTts(text, bubbleEl) {
    if (!autoPlay) return;
    ttsQueue.push({ text, bubbleEl });
    if (!ttsQueueActive) pumpTtsQueue();
  }
  function pumpTtsQueue() {
    ttsQueueActive = true;
    const step = () => {
      if (!ttsQueue.length) { ttsQueueActive = false; return; }
      const item = ttsQueue.shift();
      playOne(item.text, item.bubbleEl, step);
    };
    step();
  }

  function makeBubble(role, text, imgs) {
    const row = document.createElement('div');
    row.className = 'row' + (role === 'user' ? ' mine' : '') + (role === 'err' ? ' err' : '');
    const b = document.createElement('div');
    b.className = 'bubble';
    const list0 = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []);
    if (list0.length) {
      b.classList.add('img-bubble');
      for (const im of list0) {
        const el = document.createElement('img');
        el.className = 'chat-img';
        el.loading = 'lazy';
        el.decoding = 'async';
        el.src = String(im).startsWith('data:') ? String(im) : BASE + '/img/' + im;
        el.addEventListener('load', keepBottom);
        el.addEventListener('error', keepBottom);
        b.appendChild(el);
      }
      if (text) {
        const t = document.createElement('div');
        t.textContent = text;
        b.appendChild(t);
      }
    } else {
      b.textContent = text;
    }
    if (role === 'assistant') {
      b.classList.add('tts');
      b.title = '点击朗读 / 再点停止';
      b.addEventListener('click', () => toggleBubble(text, b));
    }
    row.appendChild(b);
    return row;
  }
  function addBubble(role, text, img) {
    hideTyping();
    const row = makeBubble(role, text, img);
    list.appendChild(row);
    scrollBottom();
    if (role === 'user') avatarState('listening');
    if (role === 'assistant') avatarState('reply');
    return row.querySelector('.bubble');
  }
  function addDivider(text) {
    const d = document.createElement('div');
    d.className = 'divider';
    d.textContent = text;
    list.appendChild(d);
  }
  function showTyping() {
    if (S.typing) return;
    const row = document.createElement('div');
    row.className = 'row typing';
    row.innerHTML = '<div class="bubble"><i></i><i></i><i></i></div>';
    list.appendChild(row);
    S.typing = row;
    // 计时：让她「还在想」这件事有可见的进展，而不是一片死寂
    S.typingAt = Date.now();
    S.typingLabel = '正在输入…';
    setStatus(S.typingLabel, true);
    avatarState('thinking');
    clearInterval(S.typingTick);
    S.typingTick = setInterval(() => {
      if (!S.typing) return;
      const sec = Math.floor((Date.now() - S.typingAt) / 1000);
      if (sec >= 4) setStatus((S.typingLabel || '正在输入…') + ' ' + sec + 's', true);
    }, 1000);
    scrollBottom();
  }
  // 只想换提示语、不想重开计时的时候用
  function setTypingLabel(text) {
    S.typingLabel = text;
    if (S.typing) setStatus(text, true);
  }
  function hideTyping() {
    clearInterval(S.typingTick);
    S.typingTick = null;
    if (S.typing) { S.typing.remove(); S.typing = null; }
    setStatus('', false);
    if (!S.queue.length) avatarState('idle');
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function wake() { if (S.wake) { const r = S.wake; S.wake = null; r(); } }
  function waitWake() { return new Promise((r) => { S.wake = r; }); }
  function kickPump() { if (S.idx < S.queue.length) wake(); }

  function stamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }

  function renderAll(keepScroll) {
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    list.innerHTML = '';
    if (S.total > S.history.length) {
      const more = document.createElement('div');
      more.className = 'load-more';
      more.textContent = '加载更早的聊天';
      more.addEventListener('click', loadMore);
      list.appendChild(more);
    }
    if (S.history.length) {
      addDivider(stamp());
      for (const m of S.history) list.appendChild(makeBubble(m.role, m.content, m.imgs || m.img));
      if (keepScroll) { list.scrollTop = list.scrollHeight - prevHeight + prevTop; followBottom = false; }
      else scrollBottom();
    }
    updateUsage();
  }

  async function loadMore() {
    try {
      const before = S.history.length;
      const r = await fetch(BASE + '/current?limit=' + (before + 100));
      if (!r.ok) return;
      const d = await r.json();
      if (!d || !Array.isArray(d.messages)) return;
      S.history = mergeMessages(d.messages, S.history);
      S.total = d.total || S.total;
      renderAll(true);
    } catch {}
  }

  function updateUsage() {
    const el = $('usage');
    if (!el) return;
    const n = S.history.length;
    const t = S.total || n;
    const seen = Math.min(n, S.limit || 26);
    el.textContent = n
      ? `已加载 ${n} 条${t > n ? `（这段共 ${t} 条）` : ''} · 每轮模型看最近 ${seen} 条（上限 ${S.limit || 26}）`
      : '还没开始聊';
  }

  // ---------- 落盘 ----------
  function scheduleSave(delay = 120) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveNow(); }, delay);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!S.threadId) S.threadId = newId();
    if (!S.title && S.history.length) S.title = titleOf(S.history);
    // 先拉服务器，合并（并集），避免两个设备互相覆盖
    try {
      const cur = await (await fetch(BASE + '/current')).json();
      if (cur && Array.isArray(cur.messages) && cur.threadId === S.threadId && cur.messages.length) {
        S.history = mergeMessages(cur.messages, S.history);
      }
    } catch {}
    const payload = {
      threadId: S.threadId,
      title: S.title,
      notes: S.notes,
      messages: S.history,
      createdAt: S.createdAt || new Date().toISOString(),
    };
    try {
      await fetch(BASE + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {}
    write(LS.hist, S.history.slice(-CACHE_MAX));
    write(LS.notes, S.notes);
    write(LS.thread, S.threadId);
  }

  // ---------- 逐条吐气泡 ----------
  async function typeOut(text, gen) {
    const total = Math.min(1800, 380 + text.length * 45);
    showTyping();
    if (total > 1000) {
      await sleep(total * 0.55);
      if (gen !== S.gen) return;
      hideTyping();
      await sleep(190);
      if (gen !== S.gen) return;
      showTyping();
      await sleep(total * 0.45);
    } else {
      await sleep(total);
    }
    if (gen !== S.gen) return;
    hideTyping();
  }

  async function pump(gen) {
    while (true) {
      if (gen !== S.gen) return;
      if (S.idx >= S.queue.length) {
        if (S.done) { hideTyping(); return; }
        await waitWake();
        continue;
      }
      const text = S.queue[S.idx++];
      await typeOut(text, gen);
      if (gen !== S.gen) return;
      const bubbleEl = addBubble('assistant', text);
      enqueueTts(text, bubbleEl);
      S.history.push({ role: 'assistant', content: text, ts: Date.now() });
      scheduleSave();
      updateUsage();
      await sleep(150 + Math.random() * 220);
    }
  }

  // ---------- 发图片（支持多张）----------
  let pendingImages = [];
  function compressImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 1024;
          let w = img.width, h = img.height;
          if (w > max || h > max) {
            if (w > h) { h = Math.round(h * max / w); w = max; }
            else { w = Math.round(w * max / h); h = max; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.onerror = () => resolve(String(reader.result || ''));
        img.src = String(reader.result || '');
      };
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }
  function renderPreviews() {
    const box = $('preview');
    if (!box) return;
    box.innerHTML = '';
    if (!pendingImages.length) { box.hidden = true; return; }
    box.hidden = false;
    pendingImages.forEach((url, i) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      const im = document.createElement('img');
      im.src = url;
      const x = document.createElement('button');
      x.className = 'preview-x';
      x.textContent = '✕';
      x.addEventListener('click', () => { pendingImages.splice(i, 1); renderPreviews(); });
      item.appendChild(im);
      item.appendChild(x);
      box.appendChild(item);
    });
  }
  async function addFiles(files) {
    const list = Array.from(files || []).filter((f) => f && f.type && f.type.startsWith('image/')).slice(0, 9);
    for (const f of list) {
      const d = await compressImage(f);
      if (d) pendingImages.push(d);
    }
    renderPreviews();
  }
  $('pic').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async () => {
    await addFiles($('file').files);
    $('file').value = '';
  });

  // 粘贴图片（电脑上 Ctrl+V）
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  // 拖拽图片到页面任意位置
  ['dragenter', 'dragover'].forEach((t) => {
    document.body.addEventListener(t, (e) => e.preventDefault());
  });
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) await addFiles(e.dataTransfer.files);
  });

  // ---------- 发送 ----------
  async function send() {
    const text = input.value.trim();
    const images = pendingImages.slice();
    if (!text && !images.length) return;
    unlockAudio();
    input.value = '';
    autosize();
    if (images.length) {
      addBubble('user', text, images);
      const label = text || (images.length > 1 ? `（发了 ${images.length} 张图）` : '（发了张图）');
      S.history.push({ role: 'user', content: label, ts: Date.now() });
    } else {
      addBubble('user', text);
      S.history.push({ role: 'user', content: text, ts: Date.now() });
    }
    pendingImages = [];
    renderPreviews();
    if (!S.title) S.title = titleOf(S.history);
    scheduleSave(300);
    updateUsage();
    runTurn(text, false, images);
  }

  async function runTurn(text, isRetry, images) {
    const gen = ++S.gen;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    hideTyping();
    wake();
    S.queue = [];
    S.idx = 0;
    S.done = false;

    const kick = setTimeout(() => { if (gen === S.gen) showTyping(); }, 280);
    pump(gen);

    let got = 0;
    let timedOut = false;
    let idleTimer = null;
    // 服务端每 2 秒会发心跳；但手机走蜂窝/Tailscale 时抖动大、心跳可能被缓冲推迟，
    // 所以「静默」判定放宽到 90 秒（和后端 stall 一致），只要收到过任意字节就重置。
    const timeoutMs = 90000;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (gen !== S.gen) return;
        timedOut = true;
        try { ctrl.abort(); } catch {}
      }, timeoutMs);
    };
    armIdle();

    try {
      // 只发最近 S.limit 条（后端 historyTurns 也按这个数切），省上行带宽、更快拿到首字节
      const payload = { notes: S.notes, messages: S.history.slice(-S.limit) };
      if (images && images.length) payload.images = images;
      const resp = await fetch(BASE + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let evt;
            try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (gen !== S.gen) return;
            if (evt.type === 'bubble') { got += 1; S.queue.push(evt.text); if (autoPlay) prefetchTts(evt.text); wake(); armIdle(); }
            else if (evt.type === 'thinking') { if (!S.typing) showTyping(); armIdle(); }
            else if (evt.type === 'wait') { setTypingLabel(evt.text || '她那边有点挤，我排一下队…'); armIdle(); }
            else if (evt.type === 'error') { showError(evt.message, !!evt.quota); }
            else if (evt.type === 'info') {
              if (evt.limit) S.limit = evt.limit;
              if (evt.imgs && evt.imgs.length) {
                const last = [...S.history].reverse().find((m) => m.role === 'user');
                if (last && !last.imgs) { last.imgs = evt.imgs; scheduleSave(300); }
              }
              updateUsage();
            }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError' && gen === S.gen) {
        if (isNetworkError(e) && got === 0) {
          // 断网：不弹死错，进入自动重连，等网络回来把这句话补发出去
          markOffline();
          pendingResend = () => { if (gen === S.gen) runTurn(text, isRetry, images); };
        } else {
          showError('连不上：' + e.message);
        }
      }
    } finally {
      clearTimeout(kick);
      clearTimeout(idleTimer);
      if (gen === S.gen) {
        S.done = true;
        wake();
        if (timedOut && got === 0) {
          if (!isRetry) {
            // 连接确实断了才重连，而且先让状态栏自己说话，别让她莫名其妙来一句「诶」
            setTypingLabel('连接断了，我重连一下…');
            showTyping();
            setTimeout(() => { if (gen === S.gen) runTurn(text, true, images); }, 800);
          } else {
            addBubble('assistant', '好像还是没接上，你等会儿再说一句？');
          }
        }
      }
      if (got > 0 && gen === S.gen) {
        S.notesTick = (S.notesTick || 0) + 1;
        if (S.notesTick % 5 === 0) updateNotes();
      }
    }
  }

  async function updateNotes() {
    if (S.notesBusy || S.history.length < 4) return;
    S.notesBusy = true;
    try {
      const r = await fetch(BASE + '/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: S.notes, messages: S.history.slice(-60) }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d.updated && d.notes) {
        S.notes = normalizeNotes(d.notes);
        renderMem();
        scheduleSave();
      }
    } catch {} finally {
      S.notesBusy = false;
    }
  }

  function showError(msg, isQuota) {
    hideTyping();
    if (isQuota) {
      // 日卡额度耗尽：用她的口吻提示，别用冷冰冰的报错
      const row = makeBubble('err', '猫粮吃完啦，我这边断粮了 (´｡• ᵕ •｡) 去续一下再接着聊～');
      const el = row.querySelector('.bubble');
      if (el) el.classList.add('quota-bubble');
      list.appendChild(row);
      scrollBottom();
      return;
    }
    if (/429|并发|拥挤|稍后重试|rate.?limit/i.test(String(msg)) && !isQuota) {
      // 并发被占满：这不是坏了，就是排队，用她的口吻轻轻带过
      const row = makeBubble('err', '刚才有点挤，没接上话。你再发一次就好～');
      list.appendChild(row);
      scrollBottom();
      return;
    }
    list.appendChild(makeBubble('err', msg));
    scrollBottom();
  }

  // ---------- 断线自动重连 ----------
  // 背景：手机走 Tailscale 中继（常经香港），网络一抖动就 Failed to fetch。
  // 做法：探活失败不弹死错，先静默重试；恢复后自动把没发出去的那句补发。
  let netDown = false;        // 当前是否认为断网
  let probeTimer = null;      // 重试定时器
  let probeDelay = 0;         // 当前退避间隔
  let pendingResend = null;   // 断线时没发出去的消息

  function isNetworkError(e) {
    if (!e) return false;
    const m = String(e.message || e);
    return e.name === 'TypeError' || /Failed to fetch|NetworkError|load failed|timeout|The operation was aborted/i.test(m);
  }

  function markOnline() {
    if (!netDown) return;
    netDown = false;
    probeDelay = 0;
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    setStatus('网络回来了', false);
    setTimeout(() => { if (!netDown) setStatus('', false); }, 1600);
    // 把断线期间没发出去的那句补发
    if (pendingResend) {
      const job = pendingResend;
      pendingResend = null;
      setTimeout(() => { try { job(); } catch {} }, 200);
    } else {
      // 没有待补发的，就静默补拉一次历史，把断线期间别处发的内容并进来
      setTimeout(() => { try { syncFromServer(); } catch {} }, 300);
    }
  }

  async function syncFromServer() {
    if (netDown) return;
    try {
      const cur = await (await fetch(BASE + '/current?limit=300', { cache: 'no-store' })).json();
      if (!cur || !Array.isArray(cur.messages) || !cur.messages.length) return;
      if (cur.threadId && cur.threadId !== S.threadId) return;
      const merged = mergeMessages(cur.messages, S.history);
      if (merged.length === S.history.length) return; // 没变化，别重绘
      S.history = merged.length > CACHE_MAX ? merged.slice(-CACHE_MAX) : merged;
      S.total = cur.total || S.history.length;
      write(LS.hist, S.history.slice(-CACHE_MAX));
      renderAll();
      updateUsage();
    } catch {}
  }

  function markOffline() {
    netDown = true;
    if (probeTimer) return; // 已经在重试循环里
    probeDelay = 0;
    scheduleProbe();
  }

  function scheduleProbe() {
    if (!netDown) return;
    // 退避：1s → 2s → 3s → 5s，然后一直 5s
    probeDelay = probeDelay === 0 ? 1000 : Math.min(probeDelay + 1000, 5000);
    setStatus('网络断了，正在重连…', false);
    probeTimer = setTimeout(runProbe, probeDelay);
  }

  async function runProbe() {
    probeTimer = null;
    if (!netDown) return;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(BASE + '/info', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(to);
      if (r.ok) { markOnline(); return; }
    } catch {}
    scheduleProbe();
  }

  // 浏览器自己报网络恢复时，立刻探一次（不用等退避）
  window.addEventListener('online', () => { if (netDown) { probeDelay = 0; runProbe(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Android 浏览器切回前台后可能暂停 audio，即使页面还活着；尝试继续
    // 当前句子。预取请求自身带超时，完成/失败后会继续队列。
    if (ttsAudio && playingEl && ttsAudio.paused) ttsAudio.play().catch(() => {});
    if (netDown) { probeDelay = 0; runProbe(); }
  });

  // ---------- 记忆展示 ----------
  const MEM_LABELS = [
    ['about_you', '关于对方'],
    ['how_to_talk', 'TA 说过的习惯'],
    ['between_us', '你们之间'],
    ['about_me', '你自己'],
  ];
  function renderMem() {
    const box = $('mem');
    if (!box) return;
    box.innerHTML = '';
    let any = false;
    for (const [key, label] of MEM_LABELS) {
      const items = S.notes[key] || [];
      if (!items.length) continue;
      any = true;
      const wrap = document.createElement('div');
      wrap.className = 'mem-group';
      const h = document.createElement('div');
      h.className = 'mem-label';
      h.textContent = label;
      wrap.appendChild(h);
      const ul = document.createElement('ul');
      items.forEach((it, idx) => {
        const li = document.createElement('li');
        li.className = 'mem-item';
        const txt = document.createElement('span');
        txt.className = 'mem-text';
        txt.textContent = it;
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'mini';
        edit.textContent = '改';
        edit.title = '编辑';
        edit.addEventListener('click', () => memInlineEdit(li, key, idx, it));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mini';
        del.textContent = '删';
        del.title = '删除';
        del.addEventListener('click', () => memDelete(key, idx));
        li.appendChild(txt);
        li.appendChild(edit);
        li.appendChild(del);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
      box.appendChild(wrap);
    }
    if (!any) box.innerHTML = '<p class="mem-empty">还没记住什么，多聊几句就有了。</p>';
  }

  // 单条记忆就地编辑：把文字换成输入框 + 保存/取消
  function memInlineEdit(li, field, idx, oldText) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldText;
    input.className = 'mem-edit-input';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mini';
    save.textContent = '存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mini';
    cancel.textContent = '取消';
    const actions = document.createElement('span');
    actions.className = 'mem-actions';
    actions.appendChild(save);
    actions.appendChild(cancel);
    li.innerHTML = '';
    li.appendChild(input);
    li.appendChild(actions);
    input.focus();
    let done = false;
    const finish = () => { if (!done) { done = true; renderMem(); } };
    save.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) { finish(); return; }
      await memEdit(field, idx, 'edit', text);
      finish();
    });
    cancel.addEventListener('click', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save.click();
      if (e.key === 'Escape') finish();
    });
  }

  async function memEdit(field, idx, action, text) {
    try {
      const r = await fetch(BASE + '/mem-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: S.threadId, field, index: idx, action, text }),
      });
      const d = await r.json();
      if (r.ok && d.notes) {
        S.notes = normalizeNotes(d.notes);
        renderMem();
        write(LS.notes, S.notes);
      } else if (!r.ok) {
        alert((d && d.error) || '操作失败');
      }
    } catch {
      alert('操作失败');
    }
  }

  async function memDelete(field, idx) {
    if (!confirm('删掉这条记忆？')) return;
    await memEdit(field, idx, 'delete');
  }

  // ---------- 输入框 ----------
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);

  // ---------- 会话切换 ----------
  const panel = $('panel');

  async function newThread() {
    await saveNow();
    S.gen += 1;
    if (ctrl) ctrl.abort();
    S.queue = []; S.idx = 0; S.done = true;
    S.history = [];
    S.threadId = newId();
    S.title = '';
    S.createdAt = new Date().toISOString();
    write(LS.hist, []);
    renderAll();
    await saveNow();
  }

  async function openThread(id) {
    if (!id || id === S.threadId) { panel.classList.remove('open'); return; }
    await saveNow();
    try {
      const t = await (await fetch(BASE + '/thread?id=' + encodeURIComponent(id))).json();
      if (!t || !Array.isArray(t.messages)) return;
      S.gen += 1;
      if (ctrl) ctrl.abort();
      S.queue = []; S.idx = 0; S.done = true;
      S.history = t.messages;
      S.notes = normalizeNotes(t.notes);
      S.threadId = t.threadId;
      S.title = t.title || '';
      S.createdAt = t.createdAt;
      renderAll();
      renderMem();
      await saveNow();
      panel.classList.remove('open');
    } catch {}
  }

  async function renderThreads() {
    const box = $('threads');
    if (!box) return;
    box.innerHTML = '<p class="mem-empty">读取中…</p>';
    try {
      const d = await (await fetch(BASE + '/threads')).json();
      const items = (d.threads || []).filter((t) => t.threadId !== S.threadId);
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<p class="mem-empty">还没有别的对话。</p>';
        return;
      }
      for (const t of items) {
        const btn = document.createElement('button');
        btn.className = 'thread';
        const when = t.updatedAt ? t.updatedAt.slice(5, 16).replace('T', ' ') : '';
        btn.innerHTML = `<span class="thread-title"></span><span class="thread-meta"></span>`;
        btn.querySelector('.thread-title').textContent = t.title;
        btn.querySelector('.thread-meta').textContent = `${t.count} 条 · ${when}`;
        btn.addEventListener('click', () => openThread(t.threadId));
        box.appendChild(btn);
      }
    } catch {
      box.innerHTML = '<p class="mem-empty">读取失败。</p>';
    }
  }

  async function renderEpisodes() {
    const box = $('episodes');
    if (!box) return;
    box.innerHTML = '<p class="mem-empty">读取中…</p>';
    try {
      const d = await (await fetch(BASE + '/episodes')).json();
      const items = d.episodes || [];
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<p class="mem-empty">还没有事件卡，多聊几句就有了。</p>';
        return;
      }
      for (const e of items) {
        const div = document.createElement('div');
        div.className = 'episode';
        const t = document.createElement('div');
        t.className = 'episode-theme';
        t.textContent = e.theme;
        const c = document.createElement('div');
        c.className = 'episode-content';
        c.textContent = e.content;
        div.appendChild(t);
        div.appendChild(c);
        if (e.mood) {
          const m = document.createElement('div');
          m.className = 'episode-mood';
          m.textContent = e.mood;
          div.appendChild(m);
        }
        const actions = document.createElement('div');
        actions.className = 'episode-actions';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'mini';
        edit.textContent = '改';
        edit.title = '编辑';
        edit.addEventListener('click', () => episodeInlineEdit(div, e));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mini';
        del.textContent = '删';
        del.title = '删除';
        del.addEventListener('click', () => episodeDelete(e));
        actions.appendChild(edit);
        actions.appendChild(del);
        div.appendChild(actions);
        box.appendChild(div);
      }
    } catch {
      box.innerHTML = '<p class="mem-empty">读取失败。</p>';
    }
  }

  // 事件卡就地编辑：主题 + 内容 + 心情 三个输入框
  function episodeInlineEdit(div, e) {
    const themeIn = document.createElement('input');
    themeIn.type = 'text';
    themeIn.value = e.theme || '';
    themeIn.className = 'mem-edit-input';
    const contentIn = document.createElement('input');
    contentIn.type = 'text';
    contentIn.value = e.content || '';
    contentIn.className = 'mem-edit-input';
    const moodIn = document.createElement('input');
    moodIn.type = 'text';
    moodIn.value = e.mood || '';
    moodIn.className = 'mem-edit-input';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mini';
    save.textContent = '存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mini';
    cancel.textContent = '取消';
    const actions = document.createElement('div');
    actions.className = 'episode-actions';
    actions.appendChild(save);
    actions.appendChild(cancel);
    div.innerHTML = '';
    div.appendChild(themeIn);
    div.appendChild(contentIn);
    div.appendChild(moodIn);
    div.appendChild(actions);
    themeIn.focus();
    let done = false;
    const finish = () => { if (!done) { done = true; renderEpisodes(); } };
    save.addEventListener('click', async () => {
      await episodeEdit(e.id, 'edit', {
        theme: themeIn.value,
        content: contentIn.value,
        mood: moodIn.value,
      });
      finish();
    });
    cancel.addEventListener('click', finish);
    [themeIn, contentIn, moodIn].forEach((el) => {
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') save.click();
        if (ev.key === 'Escape') finish();
      });
    });
  }

  async function episodeEdit(id, action, fields) {
    try {
      const r = await fetch(BASE + '/episode-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, ...fields }),
      });
      const d = await r.json();
      if (!r.ok) {
        alert((d && d.error) || '操作失败');
      }
    } catch {
      alert('操作失败');
    }
  }

  async function episodeDelete(e) {
    if (!confirm('删掉这张事件卡？')) return;
    await episodeEdit(e.id, 'delete');
    renderEpisodes();
  }

  // ---------- 设置 ----------
  $('gear').addEventListener('click', () => {
    renderMem();
    updateUsage();
    renderThreads();
    renderEpisodes();
    panel.classList.add('open');
  });
  panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); });
  $('save').addEventListener('click', () => panel.classList.remove('open'));
  const closePanel = $('close-panel');
  if (closePanel) closePanel.addEventListener('click', () => panel.classList.remove('open'));

  // 自动朗读开关
  const apEl = $('autoplay');
  if (apEl) {
    apEl.checked = autoPlay;
    apEl.addEventListener('change', () => {
      autoPlay = apEl.checked;
      write('companion.autoplay', autoPlay);
      if (autoPlay) unlockAudio();
      else stopAllTts();
    });
  }

  $('new').addEventListener('click', async () => {
    if (S.history.length && !confirm('开一段新的对话？现在这段会存进归档，随时能翻回来。')) return;
    await newThread();
  });

  $('copy').addEventListener('click', async () => {
    if (!S.history.length) return;
    const text = S.history.map((m) => (m.role === 'user' ? '我：' : 'ta：') + m.content).join('\n');
    const btn = $('copy');
    const done = () => {
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制对话'; }, 1200);
    };
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch {}
      ta.remove();
    }
  });

  $('clear-mem').addEventListener('click', async () => {
    if (!confirm('清空它记住的东西？对话不会删。')) return;
    S.notes = normalizeNotes(EMPTY_NOTES);
    renderMem();
    scheduleSave(100);
  });

  $('reset').addEventListener('click', async () => {
    if (!confirm('清空全部？这段对话和它记住的东西都会从当前这段里删掉（磁盘上的归档还在）。')) return;
    await saveNow();
    S.gen += 1;
    if (ctrl) ctrl.abort();
    S.history = [];
    S.notes = normalizeNotes(EMPTY_NOTES);
    S.threadId = newId();
    S.title = '';
    S.queue = []; S.idx = 0; S.done = true;
    write(LS.hist, []);
    renderAll();
    renderMem();
    await saveNow();
    panel.classList.remove('open');
  });

  // 关页面 / 切走时立刻写一次（sendBeacon 在页面卸载时也能发出去）
  function flush() {
    try {
      const payload = JSON.stringify({
        threadId: S.threadId, title: S.title, notes: S.notes,
        messages: S.history, createdAt: S.createdAt,
      });
      navigator.sendBeacon(BASE + '/save', new Blob([payload], { type: 'application/json' }));
    } catch {}
  }
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // ---------- 启动 ----------
  (function boot() {
    // 先用本地缓存立刻上屏，绝不等网络。手机上走 Tailscale 拉一次要好几百毫秒到几秒，
    // 干等着就是那个「空白聊天窗口」。
    const localHist = read(LS.hist, []);
    const localThread = read(LS.thread, '');    S.history = Array.isArray(localHist) ? localHist : [];
    S.total = S.history.length;
    S.notes = normalizeNotes(read(LS.notes, EMPTY_NOTES));
    S.threadId = localThread || newId();
    S.title = S.history.length ? titleOf(S.history) : '';
    renderAll();
    renderMem();
    autosize();
    try { const el = $('ver'); if (el) el.textContent = 'v20261120k'; } catch {}

    // 缓存里的东西先给用户用起来，剩下的在后台补
    let painted = S.history.length > 0;
    const firstPaint = () => {
      if (painted) return;
      painted = true;
      renderAll();
    };
    // 本地一条都没有时，别让页面干瞪眼：给个「正在读取」的提示
    if (!painted) setStatus('读取中…', false);

    (async () => {
      let remote = null;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        remote = await (await fetch(BASE + '/current?limit=300', { cache: 'no-store', signal: ctl.signal })).json();
        clearTimeout(timer);
      } catch {
        // 首屏断网：先显示本地记录，并进入自动重连循环，网络一恢复就补齐
        if (!painted) setStatus('连不上，先看本地的', false);
        firstPaint();
        markOffline();
        return;
      }
      const remoteOk = remote && Array.isArray(remote.messages) && remote.messages.length;

      if (remoteOk) {
        // 合并服务器和本地（并集），两边都不丢
        const merged = mergeMessages(remote.messages, localHist);
        S.history = merged.length > CACHE_MAX ? merged.slice(-CACHE_MAX) : merged;
        S.total = remote.total || S.history.length;
        S.notes = normalizeNotes(remote.notes);
        S.threadId = remote.threadId || S.threadId;
        S.title = remote.title || S.title;
        S.createdAt = remote.createdAt;
        write(LS.thread, S.threadId);
        write(LS.hist, S.history.slice(-CACHE_MAX));
        write(LS.notes, S.notes);
        renderAll();
        renderMem();
      } else if (!painted) {
        renderAll();
        renderMem();
      }
      setStatus('', false);
      scheduleSave(200);
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const info = await (await fetch(BASE + '/info', { cache: 'no-store', signal: ctl.signal })).json();
        clearTimeout(timer);
        if (info && info.historyTurns) S.limit = info.historyTurns;
        if (info && info.model) S.model = info.model;
        updateUsage();
      } catch {}
    })();

    input.focus();
  })();
})();
