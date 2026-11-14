# 2026-11-14 存档：手感确认可用的一版

这一天用户确认「已经可以称得上在交谈，也能勾起聊下去的欲望」。

这个目录是当时正在跑的四份文件的快照，只读留档，不参与运行。
想回到这一版，把这里的文件覆盖回上一级 `web/` 和 `index.js` 即可（index.js 需要重启 DSH 才生效，prompt.md / notes.md / tune.json 改完即生效）。

- `prompt.md`   人格与说话规则（决定"像不像人"的核心）
- `notes.md`    后台记忆整理规则
- `tune.json`   模型、字数、气泡切分等参数
- `index.js`    插件本体（路由、切气泡、调模型）

当时的参数：model = deepseek-v4-pro，maxTokens 600，maxBubbles 6，historyTurns 26，bubbleSoft 30，bubbleHard 46。
