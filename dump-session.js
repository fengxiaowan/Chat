const fs = require('node:fs');
const zlib = require('node:zlib');
const file = 'C:\\Users\\lyy44\\.dsh\\sessions\\--C-Users-lyy44-Documents-deepseek-harness-default-workspace--\\session-8aea4545-97ea-43ad-a211-08fd0322a47e\\session.v4.jsonl.zstd';
const buf = fs.readFileSync(file);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let idx = 0;
const starts = [];
while ((idx = buf.indexOf(magic, idx)) !== -1) { starts.push(idx); idx += 4; }
starts.push(buf.length);
let out = '';
for (let i = 0; i < starts.length - 1; i++) {
  try { out += zlib.zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8'); }
  catch (e) { /* skip */ }
}
console.log('total chars:', out.length);
const lines = out.split('\n').filter(Boolean);
console.log('lines:', lines.length);
// print last few message events with user/assistant text
for (const [i, line] of lines.entries()) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const t = o.type;
  if (t === 'user/message' || t === 'agent/message' || t === 'user/input' || t === 'assistant/message' || /message/i.test(t)) {
    const d = o.data || {};
    let txt = '';
    if (Array.isArray(d.content)) {
      txt = d.content.map(c => c.type === 'text' ? c.text : (c.type === 'image' ? '[image]' : '[' + c.type + ']')).join('');
    } else if (typeof d.text === 'string') txt = d.text;
    if (txt) console.log('=== ' + t + ' (' + (d.role || '') + ') ===\n' + txt.slice(0, 1200) + '\n');
  }
}
