// 生成一张有明显内容的图（画一个"太阳"），发给 relay，看模型能否正确描述
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync('./companion-standalone/config.json', 'utf8'))
// 生成 200x200 图：黄色圆 + 放射线（太阳）
const cv = new OffscreenCanvas(200, 200)
