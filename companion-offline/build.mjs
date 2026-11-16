// 生成单文件离线版：把 style.css + app.js + 三份 md 全内联进一个 html
// 用法：node build.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = new URL('./', import.meta.url)
const WEB = new URL('../companion-plugin/web/', import.meta.url)

const rd = (name) => readFileSync(new URL(name, WEB), 'utf8')

const style = rd('style.css')
const app = readFileSync(new URL('./app.js', HERE), 'utf8')
const prompt = rd('prompt.md')
const notes = rd('notes.md')
const episodes = rd('episodes.md')
const tune = JSON.parse(rd('tune.json'))
const pkg = JSON.parse(readFileSync(new URL('./settings.json', HERE), 'utf8'))

const esc = (s) => String(s).replace(/<\/script/gi, '<\\/script')

// 目标形态：pages = 部署到 Cloudflare Pages（走 /v1 代理，不带 key）
//           local = 本地单文件（直连中转站，带 key）
const TARGET = (process.argv[2] || 'local').toLowerCase()
const IS_PAGES = TARGET === 'pages'

const CONFIG = {
  baseUrl: IS_PAGES ? '/v1' : String(pkg.baseUrl || 'https://tmai.ak03.cn/v1').replace(/\/+$/, ''),
  // Pages 版把 key 放在服务器端的环境变量里，页面里一个字都不留
  apiKey: IS_PAGES ? '' : String(pkg.apiKey || ''),
  chatModel: pkg.chatModel || 'deepseek-v4-pro',
  extractModel: pkg.extractModel || 'deepseek-v4-flash',
  limit: Number(tune.historyTurns) || 26,
  maxTokens: Number(tune.maxTokens) || 180,
  temperature: typeof tune.temperature === 'number' ? tune.temperature : 1,
  maxBubbles: Number(tune.maxBubbles) || 4,
  bubbleSoft: Number(tune.bubbleSoft) || 24,
  bubbleHard: Number(tune.bubbleHard) || 38,
  ttsVoice: tune.ttsVoice || 'zh-CN-XiaoxiaoNeural',
  ttsRate: tune.ttsRate || '+8%',
  prompt,
  notesPrompt: notes,
  episodesPrompt: episodes,
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ededed">
<title>闲聊</title>
<style>
${style}
/* —— 离线版追加样式 —— */
#lock { position: fixed; inset: 0; z-index: 40; display: none; align-items: center; justify-content: center;
  background: #ededed; padding: 24px; }
#lock.open { display: flex; }
.lock-box { width: 100%; max-width: 320px; background: #fff; border-radius: 10px; padding: 22px;
  box-shadow: 0 6px 30px rgba(0,0,0,.08); }
.lock-box h2 { margin: 0 0 4px; font-size: 17px; }
.lock-box p { margin: 0 0 16px; font-size: 12px; color: #999; line-height: 1.6; }
.lock-box input { width: 100%; border: 1px solid #ddd; border-radius: 6px; padding: 10px 12px;
  font: inherit; font-size: 15px; outline: none; margin-bottom: 10px; }
.lock-box input:focus { border-color: #b6d99b; }
.lock-box button { width: 100%; border: 0; border-radius: 6px; padding: 11px 0; font: inherit;
  font-size: 15px; background: #07c160; color: #fff; cursor: pointer; }
.lock-err { color: #d33; font-size: 12px; min-height: 16px; margin: 0 0 8px; }
.sync { position: sticky; top: 0; z-index: 3; display: none; align-items: center; justify-content: space-between;
  gap: 8px; background: #fffbe8; border-bottom: 1px solid #f0e2b0; padding: 7px 12px; font-size: 12px; color: #8a6d1f; }
.sync.open { display: flex; }
.sync button { border: 1px solid #e3cf8c; background: #fff; color: #8a6d1f; border-radius: 5px;
  padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer; }
.offline .status { color: #c98b1f; }
@media (max-width: 640px) { .phone { max-width: 100%; } }
</style>
</head>
<body>
<div class="phone">
  <div id="sync" class="sync"><span id="sync-text"></span><button id="sync-btn">同步</button></div>
  <header>
    <div class="bar">
      <div class="title">
        <span id="who">TA</span>
        <span id="status" class="status"></span>
      </div>
      <div class="actions">
        <button id="new" class="gear" title="新对话">＋</button>
        <button id="gear" class="gear" title="设置">⚙</button>
      </div>
    </div>
  </header>

  <main id="list" class="list"></main>

  <footer>
    <div id="preview" class="preview" hidden></div>
    <div class="compose">
      <button id="pic" class="pic" title="发图片">🖼</button>
      <input id="file" type="file" accept="image/*" multiple hidden>
      <textarea id="input" rows="1" placeholder="说点什么…" autocomplete="off"></textarea>
      <button id="send" class="send">发送</button>
    </div>
  </footer>
</div>

<aside id="panel" class="panel">
  <div class="panel-inner">
    <div class="panel-head">
      <h2>设置 <span id="ver" class="ver"></span></h2>
      <button id="close-panel" class="panel-close" title="关闭">✕</button>
    </div>
    <p class="hint" style="margin-top:0">离线版：聊天记录存在这台设备上，不经过电脑。</p>

    <div class="field">
      <span>当前上下文</span>
      <p id="usage" class="usage"></p>
    </div>

    <div class="field">
      <span>语音</span>
      <label class="checkbox"><input type="checkbox" id="autoplay"> ta 的消息自动朗读</label>
      <p class="hint">点任意一条 ta 的气泡也能朗读/停止。</p>
    </div>

    <div class="field">
      <span>模型 <em class="tag">下一条消息生效</em></span>
      <label class="checkbox"><input type="radio" name="model" value="deepseek-v4-flash"> flash（便宜、快）</label>
      <label class="checkbox"><input type="radio" name="model" value="deepseek-v4-pro"> pro（更聪明、更贵）</label>
    </div>

    <div class="field">
      <span>它记住的 <em class="tag">聊天里自己学的</em></span>
      <div id="mem" class="mem"></div>
      <button id="clear-mem" class="link">清空记忆</button>
    </div>

    <div class="field">
      <span>事件卡 <em class="tag">聊天的浓缩记忆</em></span>
      <div id="episodes" class="episodes"></div>
    </div>

    <div class="field">
      <span>API Key <em class="tag">存在这台设备上</em></span>
      <input id="key" type="password" autocomplete="off" placeholder="sk-…">
      <p class="hint">只存本地，用来直连中转站。换设备要重新填一次。</p>
    </div>

    <div class="field">
      <span>数据</span>
      <p class="hint" id="storage-hint"></p>
      <div class="row-btns" style="margin-top:8px">
        <button id="export">导出备份</button>
        <button id="import">导入备份</button>
      </div>
      <input id="import-file" type="file" accept="application/json,.json" hidden>
    </div>

    <div class="row-btns">
      <button id="copy">复制对话</button>
      <button id="save" class="primary">好</button>
      <button id="reset">清空全部</button>
    </div>
  </div>
</aside>

<div id="lock" class="open">
  <div class="lock-box">
    <h2>闲聊</h2>
    <p>这台设备上的对话存在本地，不上传。</p>
    <input id="lock-pw" type="password" autocomplete="current-password" placeholder="密码">
    <p class="lock-err" id="lock-err"></p>
    <button id="lock-go">进入</button>
  </div>
</div>

<script>
window.__LIAO__ = ${esc(JSON.stringify(CONFIG, null, 2))};
</script>
<script>
${esc(app)}
</script>
</body>
</html>
`

const out = IS_PAGES
  ? new URL('./pages/public/index.html', HERE)
  : new URL('./liao.html', HERE)
writeFileSync(out, html, 'utf8')
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
console.log(`built [${TARGET}] ${fileURLToPath(out)}  ${kb} KB`)
if (!existsSync(new URL('./settings.json', HERE))) console.log('WARN: settings.json missing')
