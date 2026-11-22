(() => {
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const input = $('input');
  const sendBtn = $('send');

  // 折叠 / 展开侧栏（形象 + 下棋）
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
      collapseBtn.title = collapsed ? '展开侧栏' : '收起侧栏';
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

  // ---------- 下棋：井字棋 + 五子棋 ----------
  // 棋盘用 canvas 渲染（五子棋 15×15 用 DOM 格子会卡），落子决策来自后端 game-move（小喵本人）。
  // 3D 形象已断开，不再参与；以后想恢复形象，见 git 历史里的 avatar.js。
  const GAME_KEY = 'companion.game.v2';
  const TIC_KEY = 'companion.game.tictactoe.v1';
  const GOMOKU_KEY = 'companion.game.gomoku.v1';
  const G = {
    kind: 'tictactoe',   // 'tictactoe' | 'gomoku'
    size: 3,
    board: Array(9).fill(''),
    turn: 'user',        // 用户先手
    over: false,
    winner: '',          // 'user' | 'assistant' | 'draw'
    busy: false,
    lastMove: -1,
  };
  const boardEl = $('board');
  const gameStatusEl = $('game-status');
  const gameTitleEl = $('game-title');

  function makeBoard(size) { return Array(size * size).fill(''); }
  function gameKey() { return G.kind === 'gomoku' ? GOMOKU_KEY : TIC_KEY; }

  function loadGame() {
    // 优先读新键，兼容旧键
    const g = read(gameKey(), null) || read(GAME_KEY, null);
    if (g && Array.isArray(g.board)) {
      const size = Number(g.size) || (g.board.length === 225 ? 15 : g.board.length === 9 ? 3 : 0);
      if (size === 3 || size === 15) {
        G.kind = size === 15 ? 'gomoku' : 'tictactoe';
        G.size = size;
        G.board = g.board.slice();
        G.turn = g.turn === 'assistant' ? 'assistant' : 'user';
        G.over = !!g.over;
        G.winner = ['user', 'assistant', 'draw'].includes(g.winner) ? g.winner : '';
        G.lastMove = Number.isInteger(g.lastMove) ? g.lastMove : -1;
      }
    }
  }
  function saveGame() {
    write(gameKey(), { kind: G.kind, size: G.size, board: G.board, turn: G.turn, over: G.over, winner: G.winner, lastMove: G.lastMove });
  }
  function checkWinner(board, size) {
    const win = size === 15 ? 5 : 3;
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    let winCells = null;
    for (let i = 0; i < size * size; i++) {
      const v = board[i];
      if (!v) continue;
      const r = Math.floor(i / size), c = i % size;
      for (const [dr, dc] of dirs) {
        const cells = [i];
        for (let step = -1; step <= 1; step += 2) {
          let rr = r + dr * step, cc = c + dc * step;
          while (rr >= 0 && rr < size && cc >= 0 && cc < size && board[rr * size + cc] === v) {
            cells.push(rr * size + cc);
            rr += dr * step; cc += dc * step;
          }
        }
        if (cells.length >= win) {
          const uniq = [...new Set(cells)];
          if (!winCells) return { winner: v, line: uniq };
        }
      }
    }
    return board.every((v) => v) ? { winner: 'draw', line: null } : { winner: '', line: null };
  }
  function drawBoardImage() {
    const size = G.size;
    if (G.kind === 'tictactoe') return drawTicImage();
    return drawGomokuImage(size);
  }
  function drawTicImage() {
    const SZ = 300;
    const cv = document.createElement('canvas');
    cv.width = SZ; cv.height = SZ;
    const ctx = cv.getContext('2d');
    const cell = SZ / 3;
    ctx.fillStyle = '#fdfaf7'; ctx.fillRect(0, 0, SZ, SZ);
    ctx.strokeStyle = '#c9b8b0'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (let k = 1; k < 3; k++) {
      const p = cell * k;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, SZ); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(SZ, p); ctx.stroke();
    }
    for (let i = 0; i < 9; i++) {
      const v = G.board[i];
      if (!v) continue;
      const r = Math.floor(i / 3), c = i % 3;
      const cx = c * cell + cell / 2, cy = r * cell + cell / 2;
      ctx.lineWidth = 12;
      if (v === 'user') {
        ctx.strokeStyle = '#6f9ed9';
        const off = cell * 0.24;
        ctx.beginPath();
        ctx.moveTo(cx - off, cy - off); ctx.lineTo(cx + off, cy + off);
        ctx.moveTo(cx + off, cy - off); ctx.lineTo(cx - off, cy + off);
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#d98b8b';
        ctx.beginPath(); ctx.arc(cx, cy, cell * 0.27, 0, Math.PI * 2); ctx.stroke();
      }
    }
    return cv.toDataURL('image/png');
  }
  function drawGomokuImage(size) {
    const SZ = size === 15 ? 600 : 300;
    const cv = document.createElement('canvas');
    cv.width = SZ; cv.height = SZ;
    const ctx = cv.getContext('2d');
    const pad = SZ / (size + 1) / 2;
    const step = (SZ - pad * 2) / (size - 1);
    ctx.fillStyle = '#f8f1ea'; ctx.fillRect(0, 0, SZ, SZ);
    ctx.strokeStyle = '#c9b8b0'; ctx.lineWidth = size === 15 ? 2 : 4; ctx.lineCap = 'round';
    for (let k = 0; k < size; k++) {
      const p = pad + k * step;
      ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(SZ - pad, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, SZ - pad); ctx.stroke();
    }
    for (let i = 0; i < size * size; i++) {
      const v = G.board[i];
      if (!v) continue;
      const r = Math.floor(i / size), c = i % size;
      const cx = pad + c * step, cy = pad + r * step;
      if (v === 'user') {
        ctx.fillStyle = '#2f2f2f'; ctx.beginPath(); ctx.arc(cx, cy, step * 0.38, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = '#f5f5f5'; ctx.beginPath(); ctx.arc(cx, cy, step * 0.38, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#d98b8b'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    return cv.toDataURL('image/png');
  }
  function renderBoard() {
    if (!boardEl) return;
    const size = G.size;
    boardEl.innerHTML = '';
    // 井字棋：用 DOM 格子（✕ / ◯），保持原有观感
    if (G.kind === 'tictactoe') {
      boardEl.classList.remove('gomoku');
      const winLine = G.winner && G.winner !== 'draw' ? (checkWinner(G.board, 3).line || []) : [];
      for (let i = 0; i < 9; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.setAttribute('role', 'gridcell');
        const v = G.board[i];
        if (v === 'user') { cell.textContent = '✕'; cell.classList.add('occupied', 'you'); }
        else if (v === 'assistant') { cell.textContent = '◯'; cell.classList.add('occupied', 'me'); }
        if (winLine.includes(i)) cell.classList.add('win');
        cell.addEventListener('click', () => userMove(i));
        boardEl.appendChild(cell);
      }
    } else {
      // 五子棋：canvas 黑白子
      boardEl.classList.add('gomoku');
      renderGomokuCanvas(boardEl, size);
    }
    // 状态文字
    if (G.over) {
      if (G.winner === 'user') gameStatusEl.textContent = '你赢啦';
      else if (G.winner === 'assistant') gameStatusEl.textContent = '小喵赢啦';
      else if (G.winner === 'draw') gameStatusEl.textContent = '平局';
      else gameStatusEl.textContent = '轮到你';
    } else {
      gameStatusEl.textContent = G.turn === 'user' ? '轮到你' : '小喵在想…';
    }
  }
  function renderGomokuCanvas(container, size) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 600;
    cv.style.width = '100%';
    cv.style.height = '100%';
    container.appendChild(cv);
    const ctx = cv.getContext('2d');
    const SZ = cv.width;
    const pad = SZ / (size + 1) / 2;
    const step = (SZ - pad * 2) / (size - 1);
    ctx.fillStyle = '#f8f1ea'; ctx.fillRect(0, 0, SZ, SZ);
    ctx.strokeStyle = '#c9b8b0'; ctx.lineWidth = size === 15 ? 2 : 4; ctx.lineCap = 'round';
    for (let k = 0; k < size; k++) {
      const p = pad + k * step;
      ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(SZ - pad, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, SZ - pad); ctx.stroke();
    }
    // 五子棋画星位
    ctx.fillStyle = '#c9b8b0';
    for (const [r, c] of [[3,3],[3,11],[7,7],[11,3],[11,11]]) {
      ctx.beginPath(); ctx.arc(pad + c * step, pad + r * step, 3, 0, Math.PI * 2); ctx.fill();
    }
    // 获胜连线高亮
    const winLine = G.winner && G.winner !== 'draw' ? (checkWinner(G.board, size).line || []) : [];
    if (winLine.length) {
      ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = size === 15 ? 5 : 6; ctx.lineCap = 'round';
      ctx.beginPath();
      winLine.forEach((idx, n) => {
        const r = Math.floor(idx / size), c = idx % size;
        const x = pad + c * step, y = pad + r * step;
        if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // 棋子
    for (let i = 0; i < size * size; i++) {
      const v = G.board[i];
      if (!v) continue;
      const r = Math.floor(i / size), c = i % size;
      const cx = pad + c * step, cy = pad + r * step;
      if (v === 'user') {
        ctx.fillStyle = '#2f2f2f'; ctx.beginPath(); ctx.arc(cx, cy, step * 0.4, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = '#f7f7f7'; ctx.beginPath(); ctx.arc(cx, cy, step * 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#d98b8b'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    if (G.lastMove >= 0) {
      const r = Math.floor(G.lastMove / size), c = G.lastMove % size;
      ctx.strokeStyle = '#07c160'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pad + c * step, pad + r * step, step * 0.5, 0, Math.PI * 2); ctx.stroke();
    }
    cv.addEventListener('click', (e) => {
      const rect = cv.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (SZ / rect.width);
      const y = (e.clientY - rect.top) * (SZ / rect.height);
      const c = Math.round((x - pad) / step);
      const r = Math.round((y - pad) / step);
      if (r >= 0 && r < size && c >= 0 && c < size) userMove(r * size + c);
    });
  }
  function currentGame() {
    return { kind: G.kind, size: G.size, board: G.board, turn: G.turn, over: G.over, winner: G.winner };
  }
  function resetGame() {
    G.board = makeBoard(G.size);
    G.turn = 'user';
    G.over = false;
    G.winner = '';
    G.busy = false;
    G.lastMove = -1;
    saveGame();
    renderBoard();
  }
  async function aiFirst() {
    if (G.busy) return;
    G.board = makeBoard(G.size);
    G.turn = 'assistant';
    G.over = false;
    G.winner = '';
    G.busy = false;
    G.lastMove = -1;
    saveGame();
    renderBoard();
    await assistantMove();
  }
  async function userMove(i) {
    if (G.over || G.busy || G.turn !== 'user' || G.board[i]) return;
    G.board[i] = 'user';
    G.lastMove = i;
    G.turn = 'assistant';
    applyResult();
    saveGame();
    renderBoard();
    if (G.over) { announceResult(); return; }
    await assistantMove();
  }
  function applyResult() {
    const r = checkWinner(G.board, G.size);
    G.winner = r.winner;
    G.over = !!r.winner;
    if (G.over) G.turn = '';
  }
  async function announceResult() {
    if (!G.over) return;
    try {
      const r = await fetch(BASE + '/game-over', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: G.kind,
          size: G.size,
          board: G.board,
          winner: G.winner,
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.say) {
        prefetchTts(d.say);
        const bubbleEl = addBubble('assistant', d.say);
        enqueueTts(d.say, bubbleEl);
        S.history.push({ role: 'assistant', content: d.say, ts: Date.now() });
        scheduleSave(200);
      }
    } catch {}
  }
  async function assistantMove() {
    G.busy = true;
    renderBoard();
    try {
      const image = drawBoardImage();
      const r = await fetch(BASE + '/game-move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: G.kind,
          size: G.size,
          board: G.board,
          image,
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.move && d.move.index != null && !G.board[d.move.index]) {
        G.board[d.move.index] = 'assistant';
        G.lastMove = d.move.index;
        G.turn = 'user';
        applyResult();
        saveGame();
        if (d.say) {
          addBubble('assistant', d.say);
          S.history.push({ role: 'assistant', content: d.say, ts: Date.now() });
          scheduleSave(200);
        }
      }
      if (G.over) announceResult();
    } catch {
      G.turn = 'user';
    } finally {
      G.busy = false;
      renderBoard();
    }
  }
  // 模式切换：井字棋 / 五子棋 / 便签 / 形象（形象已隐藏）
  function switchGameMode(mode) {
    const avatarShell = $('avatar-shell');
    const gameShell = $('game-shell');
    const memoShell = $('memo-shell');
    if (avatarShell) avatarShell.hidden = mode !== 'avatar';
    if (gameShell) gameShell.hidden = mode !== 'game' && mode !== 'gomoku';
    if (memoShell) memoShell.hidden = mode !== 'memo';
    if (mode === 'avatar') return;
    if (mode === 'memo') {
      localStorage.setItem('companion.panelMode.v1', mode);
      loadMemoList();
      return;
    }
    const kind = mode === 'gomoku' ? 'gomoku' : 'tictactoe';
    if (G.kind !== kind) {
      G.kind = kind;
      G.size = kind === 'gomoku' ? 15 : 3;
      const saved = read(gameKey(), null);
      if (saved && Array.isArray(saved.board) && saved.board.length === G.size * G.size) {
        G.board = saved.board.slice();
        G.turn = saved.turn === 'assistant' ? 'assistant' : 'user';
        G.over = !!saved.over;
        G.winner = ['user', 'assistant', 'draw'].includes(saved.winner) ? saved.winner : '';
        G.lastMove = Number.isInteger(saved.lastMove) ? saved.lastMove : -1;
      } else {
        G.board = makeBoard(G.size);
        G.turn = 'user';
        G.over = false;
        G.winner = '';
        G.lastMove = -1;
      }
      if (gameTitleEl) gameTitleEl.textContent = kind === 'gomoku' ? '五子棋' : '井字棋';
      renderBoard();
    }
    localStorage.setItem('companion.panelMode.v1', mode);
  }
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t === tab));
      switchGameMode(tab.dataset.mode);
    });
  });
  // 默认井字棋（形象已隐藏）
  const savedMode = ['gomoku', 'memo'].includes(localStorage.getItem('companion.panelMode.v1'))
    ? localStorage.getItem('companion.panelMode.v1')
    : 'game';
  localStorage.setItem('companion.panelMode.v1', savedMode);
  document.querySelectorAll('.mode-tab').forEach((t) => {
    if (t.dataset.mode === savedMode) t.click();
  });

  // ---------- 便签纸 ----------
  // 第一步：纯文字便签，可新建/编辑/删除，服务端自动保存，电脑手机同步。
  const M = {
    list: [],
    currentId: '',
    authors: [],
    pendingWrite: '',
    saveTimer: null,
    reqSeq: 0,
  };
  const memoListEl = $('memo-list');
  const memoEditorEl = $('memo-editor');

  async function loadMemoList(preferredId) {
    const seq = ++M.reqSeq;
    try {
      const r = await fetch(BASE + '/memos', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (seq !== M.reqSeq) return;
      M.list = Array.isArray(d.memos) ? d.memos : [];
      renderMemoList();
      if (preferredId) {
        const m = M.list.find((x) => x.id === preferredId);
        if (m && memoEditorEl && memoEditorEl.value === '') {
          M.currentId = m.id;
          memoEditorEl.value = m.content || '';
          renderMemoList();
        }
      }
    } catch {}
  }
  function renderMemoList() {
    if (!memoListEl) return;
    memoListEl.innerHTML = '';
    for (const m of M.list) {
      const b = document.createElement('button');
      b.className = 'memo-tab-item' + (m.id === M.currentId ? ' active' : '');
      b.textContent = m.title || '未命名';
      b.addEventListener('click', () => selectMemo(m.id));
      memoListEl.appendChild(b);
    }
  }
  async function selectMemo(id, silent) {
    const seq = ++M.reqSeq;
    try {
      // 切换前先保存当前编辑内容，避免丢失
      if (memoEditorEl && memoEditorEl.value.trim()) {
        await saveMemoNow();
      }
      const r = await fetch(BASE + '/memo?id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (!r.ok) return;
      const memo = await r.json();
      if (seq !== M.reqSeq) return;
      if (memo && memo.id) {
        M.currentId = memo.id;
        if (memoEditorEl) memoEditorEl.value = memo.content || '';
        M.authors = Array.isArray(memo.events) ? memo.events : (Array.isArray(memo.authors) ? memo.authors : []);
        renderMemoList();
        if (!silent) localStorage.setItem('companion.memo.current', memo.id);
      }
    } catch {}
  }
  async function saveMemoNow(author) {
    if (!memoEditorEl) return;
    const content = memoEditorEl.value;
    // 空内容且还没有 id 时，不落盘，避免积累空便签
    if (!content.trim() && !M.currentId) return;
    const id = M.currentId || undefined;
    const title = content.split('\n').find((l) => l.trim()) || '';
    try {
      const r = await fetch(BASE + '/memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', id, content, title: title.slice(0, 6), author: author || 'user' }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.memo) {
        M.currentId = d.memo.id;
        M.authors = Array.isArray(d.memo.events) ? d.memo.events : (Array.isArray(d.memo.authors) ? d.memo.authors : M.authors);
        localStorage.setItem('companion.memo.current', d.memo.id);
        const i = M.list.findIndex((x) => x.id === d.memo.id);
        const item = { id: d.memo.id, title: d.memo.title || '未命名', content: d.memo.content, createdAt: d.memo.createdAt, updatedAt: d.memo.updatedAt };
        if (i >= 0) M.list[i] = item;
        else M.list.unshift(item);
        renderMemoList();
      }
    } catch {}
  }
  function scheduleMemoSave() {
    clearTimeout(M.saveTimer);
    M.saveTimer = setTimeout(saveMemoNow, 800);
  }
  async function newMemo() {
    // 新建前先保存当前内容，避免丢掉刚写的东西
    if (memoEditorEl && memoEditorEl.value.trim()) {
      await saveMemoNow();
    }
    if (memoEditorEl) memoEditorEl.value = '';
    M.currentId = '';
    M.authors = [];
    renderMemoList();
    if (memoEditorEl) memoEditorEl.focus();
  }
  async function deleteMemo() {
    if (!M.currentId) return;
    const id = M.currentId;
    try {
      const r = await fetch(BASE + '/memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (!r.ok) return;
      M.currentId = '';
      if (memoEditorEl) memoEditorEl.value = '';
      localStorage.removeItem('companion.memo.current');
      await loadMemoList();
    } catch {}
  }
  // 她写在纸上：把她写的内容追加到便签
  async function applyMemoWrite(clean) {
    clean = String(clean || '').trim();
    if (!clean) return;
    // 若还没有当前便签，先创建一个
    if (!M.currentId && memoEditorEl) {
      M.currentId = '';
    }
    let existing = '';
    if (M.currentId) {
      try {
        const r = await fetch(BASE + '/memo?id=' + encodeURIComponent(M.currentId), { cache: 'no-store' });
        if (r.ok) {
          const memo = await r.json();
          existing = memo && memo.content ? memo.content : '';
        }
      } catch {}
    }
    const merged = existing.trim() ? existing.replace(/\s+$/, '') + '\n\n' + clean : clean;
    if (memoEditorEl) memoEditorEl.value = merged;
    await saveMemoNow('assistant');
  }
  // 让她续写：调用独立接口，把她的续写落到纸上
  async function askMemoWrite(instructionText) {
    const statusEl = $('memo-status');
    if (statusEl) statusEl.textContent = '小喵在想…';
    if (!M.currentId) {
      // 没有当前便签时，先把编辑器现有内容存成一张
      if (memoEditorEl && memoEditorEl.value.trim()) {
        await saveMemoNow('user');
      }
      if (!M.currentId) {
        // 仍然没有（完全空白）：先创建一张空的
        if (memoEditorEl) memoEditorEl.value = '';
        M.currentId = '';
        if (statusEl) statusEl.textContent = '';
        return;
      }
    }
    const instruction = instructionText || input.value.trim();
    try {
      const r = await fetch(BASE + '/memo-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: M.currentId,
          instruction,
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) { if (statusEl) statusEl.textContent = ''; return; }
      const d = await r.json();
      if (d && d.written) {
        const memo = d.memo || null;
        if (memoEditorEl && memo) memoEditorEl.value = memo.content || '';
        if (memo) M.authors = Array.isArray(memo.events) ? memo.events : M.authors;
        // 提示用户她写到了纸上
        addBubble('assistant', '我写在纸上了：' + d.written);
        S.history.push({ role: 'assistant', content: '我写在纸上了：' + d.written, ts: Date.now() });
        scheduleSave(200);
        await loadMemoList(M.currentId);
      }
    } catch {} finally {
      if (statusEl) statusEl.textContent = '';
    }
  }
  // 事件绑定
  const memoNewBtn = $('memo-new');
  if (memoNewBtn) memoNewBtn.addEventListener('click', newMemo);
  const memoDelBtn = $('memo-del');
  if (memoDelBtn) memoDelBtn.addEventListener('click', deleteMemo);
  const memoAiWriteBtn = $('memo-ai-write');
  if (memoAiWriteBtn) memoAiWriteBtn.addEventListener('click', askMemoWrite);
  if (memoEditorEl) memoEditorEl.addEventListener('input', scheduleMemoSave);

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
    // 用户让她把讨论结果写上去：聊天照常回复，之后自动触发写便签
    const askWrite = /写(?:上去|进|到|在)(?:便签|纸上?)?|写到纸上|写上去|记(?:下来|到)(?:便签|纸上?)?|落到(?:便签|纸上?)?/.test(text);
    if (askWrite && M.currentId) M.pendingWrite = text;
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
      // 无论棋局是否结束，都带上当前棋局面，让她能如实回顾，而不是凭印象瞎编
      payload.game = currentGame();
      // 带上当前便签内容，让她能看到纸上写了什么
      const memoText = memoEditorEl ? memoEditorEl.value.trim() : '';
      // 只要有当前便签（哪怕空白纸），就发给她，让她知道有这张纸
      if (memoText || M.currentId) {
        payload.memo = {
          id: M.currentId || '',
          content: memoText.slice(0, 12000),
          events: M.authors || [],
        };
      }
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
            if (evt.type === 'bubble') {
              got += 1;
              // 检测她往纸上写的标记：这行落便签，其余正常显示
              const writeMatch = String(evt.text).match(/✍纸上[:：]\s*([\s\S]+?)(?:[。！？]|$)/);
              if (writeMatch && writeMatch[1] && writeMatch[1].trim()) {
                const written = writeMatch[1].trim();
                applyMemoWrite(written);
                // 同时以气泡形式提示用户，让她写的内容可见
                S.queue.push('我写在纸上了：' + written);
                if (autoPlay) prefetchTts('我写在纸上了：' + written);
              } else {
                S.queue.push(evt.text);
                if (autoPlay) prefetchTts(evt.text);
              }
              wake(); armIdle();
            }
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
      // 用户让她把讨论结果写上去：聊天回复结束后自动落纸
      if (!isRetry && gen === S.gen && M.pendingWrite && M.currentId) {
        const instr = M.pendingWrite;
        M.pendingWrite = '';
        askMemoWrite(instr);
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
    // 下棋：恢复本地棋局并渲染，绑定新一局按钮
    loadGame();
    renderBoard();
    const gameNewBtn = $('game-new');
    if (gameNewBtn) gameNewBtn.addEventListener('click', resetGame);
    const gameAiFirstBtn = $('game-ai-first');
    if (gameAiFirstBtn) gameAiFirstBtn.addEventListener('click', aiFirst);

    // 便签：恢复上次打开的便签
    const lastMemoId = localStorage.getItem('companion.memo.current') || '';
    if (lastMemoId) M.currentId = lastMemoId;
    loadMemoList(lastMemoId);

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
