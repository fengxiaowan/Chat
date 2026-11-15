(() => {
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const input = $('input');
  const sendBtn = $('send');

  const BASE = '/liao';
  const LS = {
    hist: 'companion.history.v3',
    notes: 'companion.notes.v4',
    thread: 'companion.thread.v1',
  };
  const EMPTY_NOTES = { about_you: [], how_to_talk: [], between_us: [], about_me: [] };

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
  function setStatus(text, typing) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('typing', !!typing);
  }
  let ttsAudio = null;
  let playingEl = null;
  let playEndCb = null;
  let ttsQueue = [];
  let ttsQueueActive = false;
  let autoPlay = read('companion.autoplay', false);

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
  }
  function playOne(text, bubbleEl, onEnd) {
    const a = getAudio();
    try { a.pause(); } catch {}
    if (playingEl) playingEl.classList.remove('playing');
    playingEl = bubbleEl || null;
    if (playingEl) playingEl.classList.add('playing');
    playEndCb = onEnd || null;
    a.muted = false;
    a.src = BASE + '/tts?text=' + encodeURIComponent(text);
    a.play().catch(() => { finishPlay(); });
  }
  function toggleBubble(text, bubbleEl) {
    if (playingEl === bubbleEl && ttsAudio && !ttsAudio.paused) {
      stopAllTts();
    } else {
      stopAllTts();
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

  function makeBubble(role, text) {
    const row = document.createElement('div');
    row.className = 'row' + (role === 'user' ? ' mine' : '') + (role === 'err' ? ' err' : '');
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    if (role === 'assistant') {
      b.classList.add('tts');
      b.title = '点击朗读 / 再点停止';
      b.addEventListener('click', () => toggleBubble(text, b));
    }
    row.appendChild(b);
    return row;
  }
  function addBubble(role, text) {
    hideTyping();
    const row = makeBubble(role, text);
    list.appendChild(row);
    scrollBottom();
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
    setStatus('正在输入…', true);
    scrollBottom();
  }
  function hideTyping() {
    if (S.typing) { S.typing.remove(); S.typing = null; }
    setStatus('', false);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function wake() { if (S.wake) { const r = S.wake; S.wake = null; r(); } }
  function waitWake() { return new Promise((r) => { S.wake = r; }); }

  function stamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }

  function renderAll() {
    list.innerHTML = '';
    if (S.history.length) {
      addDivider(stamp());
      for (const m of S.history) list.appendChild(makeBubble(m.role, m.content));
      scrollBottom();
    }
    updateUsage();
  }

  function updateUsage() {
    const el = $('usage');
    if (!el) return;
    const n = S.history.length;
    const seen = Math.min(n, S.limit || 26);
    el.textContent = n
      ? `这段对话 ${n} 条 · 每轮模型看最近 ${seen} 条（上限 ${S.limit || 26}）`
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
    write(LS.hist, S.history);
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

  // ---------- 发送 ----------
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    unlockAudio();
    input.value = '';
    autosize();
    addBubble('user', text);
    S.history.push({ role: 'user', content: text, ts: Date.now() });
    if (!S.title) S.title = titleOf(S.history);
    scheduleSave(300);
    updateUsage();
    runTurn(text, false);
  }

  async function runTurn(text, isRetry) {
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
    const timeoutMs = isRetry ? 30000 : 15000;
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
      const resp = await fetch(BASE + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: S.notes, messages: S.history }),
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
            if (evt.type === 'bubble') { got += 1; S.queue.push(evt.text); wake(); armIdle(); }
            else if (evt.type === 'thinking') { armIdle(); }
            else if (evt.type === 'error') { showError(evt.message); }
            else if (evt.type === 'info') { if (evt.limit) S.limit = evt.limit; updateUsage(); }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError' && gen === S.gen) showError('连不上：' + e.message);
    } finally {
      clearTimeout(kick);
      clearTimeout(idleTimer);
      if (gen === S.gen) {
        S.done = true;
        wake();
        if (timedOut && got === 0) {
          if (!isRetry) {
            addBubble('assistant', '诶，刚才卡了一下，我重接一下…');
            setTimeout(() => { if (gen === S.gen) runTurn(text, true); }, 300);
          } else {
            addBubble('assistant', '还是没接上，你再说一遍？');
          }
        }
      }
      if (got > 0 && gen === S.gen) updateNotes();
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

  function showError(msg) {
    hideTyping();
    list.appendChild(makeBubble('err', msg));
    scrollBottom();
  }

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
      for (const it of items) {
        const li = document.createElement('li');
        li.textContent = it;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
      box.appendChild(wrap);
    }
    if (!any) box.innerHTML = '<p class="mem-empty">还没记住什么，多聊几句就有了。</p>';
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
        box.appendChild(div);
      }
    } catch {
      box.innerHTML = '<p class="mem-empty">读取失败。</p>';
    }
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

  // 模型切换
  function syncModelUI() {
    document.querySelectorAll('input[name="model"]').forEach((el) => {
      el.checked = (el.value === S.model);
    });
  }
  document.querySelectorAll('input[name="model"]').forEach((el) => {
    el.addEventListener('change', async () => {
      if (!el.checked) return;
      const model = el.value;
      try {
        const r = await fetch(BASE + '/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        if (r.ok) S.model = model;
      } catch {}
    });
  });

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
  (async function boot() {
    const localHist = read(LS.hist, []);
    const localThread = read(LS.thread, '');
    let remote = null;
    try { remote = await (await fetch(BASE + '/current')).json(); } catch {}
    const remoteOk = remote && Array.isArray(remote.messages) && remote.messages.length;

    if (remoteOk) {
      // 合并服务器和本地（并集），两边都不丢
      S.history = mergeMessages(remote.messages, localHist);
      S.notes = normalizeNotes(remote.notes);
      S.threadId = remote.threadId;
      S.title = remote.title || '';
      S.createdAt = remote.createdAt;
    } else {
      S.history = localHist;
      S.notes = normalizeNotes(read(LS.notes, EMPTY_NOTES));
      S.threadId = localThread || newId();
      S.title = S.history.length ? titleOf(S.history) : '';
    }
    if (!S.threadId) S.threadId = newId();
    renderAll();
    renderMem();
    try {
      const info = await (await fetch(BASE + '/info')).json();
      if (info && info.historyTurns) S.limit = info.historyTurns;
      if (info && info.model) S.model = info.model;
      syncModelUI();
      updateUsage();
    } catch {}
    scheduleSave(200);
    autosize();
    input.focus();
    try { const el = $('ver'); if (el) el.textContent = 'v20261115c'; } catch {}
  })();
})();
