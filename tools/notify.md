# 小喵桌面提醒（notify.ps1）

给用户弹 Windows 右下角 toast 通知（带声音）。用于：活儿干完了、需要用户拍板、报错卡住时主动叫用户，别让用户干等。

## 调用方式

用 `pwsh` 工具执行（外层已经是 pwsh，直接调 `powershell -File` 或 `& ...\notify.ps1` 都行）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\lyy44\Documents\deepseek-harness\default-workspace\tools\notify.ps1" -Title "标题" -Message "内容"
```

需要用户必须立刻处理（决定/批准/报错）时加 `-Urgent`，提示音会更响：

```
... -Title "小喵：需要你拍板！" -Message "装依赖需要你同意" -Urgent
```

## 三种必提醒时机（用户明确要求）

1. 一个任务 / 一段活儿干完了 → 普通通知
2. 需要用户做决定或批准 → `-Urgent`
3. 遇到报错或卡住 → `-Urgent`

## 注意

- 文件必须是 **UTF-8 带 BOM**，否则 PS 5.1 解析中文注释会报 `Unexpected token ')'`。重写时用：
  `[System.IO.File]::WriteAllText($p, $c, (New-Object System.Text.UTF8Encoding $true))`
- 标题/内容里的 `<>&"` 已在脚本内做 XML 转义，直接传即可。
- 若现代 toast 失败会自动回退到 NotifyIcon 老式气泡。
