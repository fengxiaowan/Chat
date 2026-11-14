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
  function makeBubble(role, text) {
    const row = document.createElement('div');
    row.className = 'row' + (role === 'user' ? ' mine' : '') + (role === 'err' ? ' err' : '');
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    row.appendChild(b);
    return row;
  }
  function addBubble(role, text) {
    hideTyping();
    list.appendChild(makeBubble(role, text));
    scrollBottom();
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
      addBubble('assistant', text);
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
    input.value = '';
    autosize();
    addBubble('user', text);
    S.history.push({ role: 'user', content: text, ts: Date.now() });
    if (!S.title) S.title = titleOf(S.history);
    scheduleSave(300);
    updateUsage();

    S.gen += 1;
    const gen = S.gen;
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
    // 无进展超时：模型流偶尔会卡住不结束，导致 done 永远不来、页面挂起。
    // 超时后主动 abort 本轮，已收到的气泡保留，不弹错误。
    let idleTimer = null;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (gen !== S.gen) return;
        try { ctrl.abort(); } catch {}
      }, 60000);
    };
    armIdle();
    try {
      const resp = await fetch(BASE + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: S.notes, messages: S.history.slice(-200) }),
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
      if (gen === S.gen) { S.done = true; wake(); }
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
        body: JSON.stringify({ notes: S.notes, messages: S.history.slice(-14) }),
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

  // ---------- 设置 ----------
  $('gear').addEventListener('click', () => {
    renderMem();
    updateUsage();
    renderThreads();
    panel.classList.add('open');
  });
  panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); });
  $('save').addEventListener('click', () => panel.classList.remove('open'));

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

    if (remoteOk && remote.threadId === localThread && localHist.length > remote.messages.length) {
      // 本地比磁盘新（多半是刷新打断了自动保存），以本地为准，马上补存
      S.history = localHist;
      S.notes = normalizeNotes(read(LS.notes, remote.notes));
      S.threadId = localThread;
      S.title = remote.title || titleOf(localHist);
      S.createdAt = remote.createdAt;
    } else if (remoteOk) {
      S.history = remote.messages;
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
      updateUsage();
    } catch {}
    scheduleSave(200);
    autosize();
    input.focus();
  })();
})();
