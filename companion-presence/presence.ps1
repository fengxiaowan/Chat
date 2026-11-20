# ============================================================
# 小喵 · 在场陪伴（本地常驻小程序）
# 全局快捷键 + Vosk 本地中文语音识别 + 置顶状态图标 + 复用 8788 后端
#
# 用法：powershell -ExecutionPolicy Bypass -File presence.ps1
#       或右键 → 使用 PowerShell 运行
#
# 语音识别走本地 Vosk（Python 子进程），不依赖 Windows SAPI/WinRT，
# 因此不受"未打包应用无法用现代语音 API"的限制。
# ============================================================

# ---------- 配置（可修改）----------
$global:cfg = @{
    Hotkey           = 'Ctrl+F1'     # 快捷键。可改：Ctrl+F12、Alt+F1、Ctrl+Oem3 等
    ServerUrl        = 'http://127.0.0.1:8788'
    AuthUser         = 'user'
    AuthPassword     = '111'
    ListenMaxSec     = 12            # 单次录音最长秒数
    SilenceSec       = 1.3           # 静音多少秒判定"说完了"
    AfterSpeakListen = 4             # 她说完后再监听几秒
    HistoryTurns     = 30
    IconSize         = 36            # 状态图标直径
    IconMargin       = 14            # 离屏幕右上角距离
}

# ---------- 依赖程序集 ----------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

# ---------- C# 辅助类：热键窗口 + 圆形状态图标绘制 ----------
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class PresenceForm : Form {
    public const int WM_HOTKEY = 0x0312;

    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    // 热键触发标志：WndProc 设置，PowerShell 主循环轮询读取
    public volatile bool HotkeyTriggered = false;

    private string _state = "idle";
    private string _label = "";

    public PresenceForm(int size) {
        this.FormBorderStyle = FormBorderStyle.None;
        this.ShowInTaskbar = false;
        this.TopMost = true;
        this.StartPosition = FormStartPosition.Manual;
        this.Width = size + 16;
        this.Height = size + 16;
        // 圆形裁剪窗口（不用 TransparencyKey，避免品红锯齿边）
        int pad = 8, d = size;
        using (var path = new System.Drawing.Drawing2D.GraphicsPath()) {
            path.AddEllipse(pad, pad, d, d);
            this.Region = new Region(path);
        }
        this.ShowIcon = false;
        this.SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
    }

    public void SetState(string state, string label) {
        _state = state;
        _label = label;
        this.Opacity = (state == "idle" || state == "speaking") ? 0.30 : 0.95;
        this.Invalidate();
        this.Update();  // 强制立即重绘，确保状态图标即时刷新
    }

    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        int d = this.Width - 16;
        int pad = 8;
        Color c;
        switch (_state) {
            case "listening": c = Color.DodgerBlue; break;
            case "sending":   c = Color.Orange; break;
            case "again":     c = Color.LightSkyBlue; break;
            case "error":     c = Color.Red; break;
            case "reconnect": c = Color.Gold; break;
            case "speaking":  c = Color.Transparent; break;
            default:          c = Color.Gray; break;
        }
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        // 背景填满（Region 已裁成圆形，不会画出圆外）
        using (var b = new SolidBrush(c)) {
            g.FillEllipse(b, pad, pad, d, d);
        }
        if (_label.Length > 0) {
            using (var f = new Font("Segoe UI", 14f, FontStyle.Bold)) {
                var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                using (var b = new SolidBrush(Color.White)) {
                    g.DrawString(_label, f, b, new RectangleF(pad, pad, d, d), sf);
                }
            }
        }
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_HOTKEY) {
            HotkeyTriggered = true;
            return;
        }
        base.WndProc(ref m);
    }
}

// 图标下方的实时文字标签（显示识别到的你说的话）
public class CaptionForm : Form {
    private string _text = "";
    private Font _font = new Font("Microsoft YaHei", 12f, FontStyle.Regular);
    public CaptionForm() {
        this.FormBorderStyle = FormBorderStyle.None;
        this.ShowInTaskbar = false;
        this.TopMost = true;
        this.StartPosition = FormStartPosition.Manual;
        this.BackColor = Color.FromArgb(32, 32, 32);
        this.ForeColor = Color.White;
        this.Width = 340;
        this.Height = 34;
        this.Padding = new Padding(12, 0, 12, 0);
        this.ShowIcon = false;
        this.Opacity = 0.95;
        this.SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        // 圆角裁剪窗口（四角透明）
        using (var path = new GraphicsPath()) {
            int r = 8;
            path.AddArc(0, 0, r*2, r*2, 180, 90);
            path.AddArc(this.Width - r*2, 0, r*2, r*2, 270, 90);
            path.AddArc(this.Width - r*2, this.Height - r*2, r*2, r*2, 0, 90);
            path.AddArc(0, this.Height - r*2, r*2, r*2, 90, 90);
            path.CloseFigure();
            this.Region = new Region(path);
        }
    }
    public void SetText(string t) {
        _text = t;
        this.Invalidate();
        this.Update();  // 强制立即重绘，不依赖消息循环（Wait-Speech 里没有 DoEvents）
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        // 圆角矩形背景
        using (var path = new GraphicsPath()) {
            int r = 8;
            path.AddArc(0, 0, r*2, r*2, 180, 90);
            path.AddArc(this.Width - r*2, 0, r*2, r*2, 270, 90);
            path.AddArc(this.Width - r*2, this.Height - r*2, r*2, r*2, 0, 90);
            path.AddArc(0, this.Height - r*2, r*2, r*2, 90, 90);
            path.CloseFigure();
            using (var b = new SolidBrush(this.BackColor)) { g.FillPath(b, path); }
        }
        if (_text.Length > 0) {
            var sf = new StringFormat { Alignment = StringAlignment.Near, LineAlignment = StringAlignment.Center };
            using (var b = new SolidBrush(Color.White)) {
                g.DrawString(_text, _font, b, new RectangleF(this.Padding.Left, 0, this.Width - this.Padding.Horizontal, this.Height), sf);
            }
        }
    }
}

"@
function global:Parse-Hotkey([string]$combo) {
    $mods = [uint32]0
    $key = ''
    foreach ($part in ($combo -split '\+')) {
        switch ($part.Trim().ToLower()) {
            'ctrl'  { $mods = $mods -bor 0x0002 }
            'alt'   { $mods = $mods -bor 0x0001 }
            'shift' { $mods = $mods -bor 0x0004 }
            'win'   { $mods = $mods -bor 0x0008 }
            default { $key = $part.Trim() }
        }
    }
    return @{ Mods = $mods; Key = $key }
}

function global:Get-VirtualKey([string]$name) {
    switch ($name.ToLower()) {
        'oem3'      { return 0xC0 }
        'oem5'      { return 0xDC }
        'oemcomma'  { return 0xBC }
        'oemperiod' { return 0xBE }
        'space'     { return 0x20 }
        'tab'       { return 0x09 }
        'enter'     { return 0x0D }
        'escape'    { return 0x1B }
        'esc'       { return 0x1B }
        'f1'        { return 0x70 }
        'f2'        { return 0x71 }
        'f3'        { return 0x72 }
        'f4'        { return 0x73 }
        'f5'        { return 0x74 }
        'f6'        { return 0x75 }
        'f7'        { return 0x76 }
        'f8'        { return 0x77 }
        'f9'        { return 0x78 }
        'f10'       { return 0x79 }
        'f11'       { return 0x7A }
        'f12'       { return 0x7B }
        default {
            if ($name.Length -eq 1) {
                $c = [int][char]$name
                if ($c -ge 97 -and $c -le 122) { return ($c - 32) }
                if ($c -ge 65 -and $c -le 90) { return $c }
                if ($c -ge 48 -and $c -le 57) { return $c }
            }
            return 0
        }
    }
}

# ---------- 语音识别（独立 Python 子进程，Vosk 本地识别）----------
# 关键：Windows SAPI 8.0 桌面识别器读不到英特尔智音麦克风（AudioLevel 恒 0），
# WinRT 现代引擎又要求 MSIX 包标识（普通 PowerShell 脚本无包标识 → 0x80131509）。
# 因此改用 Vosk 本地识别：Python 子进程直接读麦克风 + 本地模型，完全绕开系统权限墙。
# 每轮热键启动一个新 Python 子进程做 N 秒识别，结果写文件后退出；
# 即使子进程出错也只影响本次识别，主进程（热键+UI+对话）永不受牵连。
$global:pythonExe = 'C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$global:listenChildScript = Join-Path $PSScriptRoot 'listen_child.py'
$global:listenResultFile = $null
$global:listenLiveFile = $null

function global:Start-Listening {
    $global:form.SetState('listening', [char]0x25CF)  # ● 正在听
    $global:listenResultFile = Join-Path $env:TEMP ("xiaomiao_listen_" + [guid]::NewGuid().ToString('N') + ".txt")
    $global:listenLiveFile = Join-Path $env:TEMP ("xiaomiao_live_" + [guid]::NewGuid().ToString('N') + ".txt")
    # 显示文字标签（空）
    $global:caption.SetText('')
    $global:caption.Visible = $true
    # 启动识别子进程（独立 Python 进程，Vosk 本地识别）
    try {
        Start-Process -FilePath $global:pythonExe -ArgumentList $global:listenChildScript,'--result',$global:listenResultFile,'--live',$global:listenLiveFile,'--max-sec',([string]$global:cfg.ListenMaxSec),'--silence-sec',([string]$global:cfg.SilenceSec) -WindowStyle Hidden
    } catch {
        Trace "listen: 子进程启动失败: $_"
    }
}

function global:Stop-Listening {
    # 隐藏文字标签
    $global:caption.Visible = $false
    $global:caption.SetText('')
    # 清理残留结果文件
    if ($global:listenResultFile) {
        try { [System.IO.File]::Delete($global:listenResultFile) } catch {}
        $global:listenResultFile = $null
    }
    if ($global:listenLiveFile) {
        try { [System.IO.File]::Delete($global:listenLiveFile) } catch {}
        $global:listenLiveFile = $null
    }
}

function global:Wait-Speech([double]$timeoutSec) {
    $start = [DateTime]::Now
    $iter = 0
    while (([DateTime]::Now - $start).TotalSeconds -lt $timeoutSec) {
        $iter++
        if ($iter -le 3) { Trace "wait: 迭代 $iter 开始" }
        Start-Sleep -Milliseconds 80
        if ($iter -le 3) { Trace "wait: 迭代 $iter DoEvents+Sleep 完成" }
        # 读取实时识别文字（子进程写入 LiveFile），显示在图标下方
        $live = ''
        if ($global:listenLiveFile -and (Test-Path $global:listenLiveFile)) {
            try { $live = [System.IO.File]::ReadAllText($global:listenLiveFile, [System.Text.Encoding]::UTF8) } catch {}
        }
        if ($live) { $global:caption.SetText($live) }
        # 从结果文件读取最终识别文本（子进程写完才存在）
        $text = ''
        if ($global:listenResultFile -and (Test-Path $global:listenResultFile)) {
            try { $text = [System.IO.File]::ReadAllText($global:listenResultFile, [System.Text.Encoding]::UTF8) } catch {}
        }
        if ($iter -le 3) { Trace "wait: 迭代 $iter ReadText=[$text]" }
        if ($text) {
            # 识别到最终内容，返回
            return $text.Trim()
        }
    }
    Trace "wait: 循环正常结束，共 $iter 次迭代"
    $text = ''
    if ($global:listenResultFile -and (Test-Path $global:listenResultFile)) {
        try { $text = [System.IO.File]::ReadAllText($global:listenResultFile, [System.Text.Encoding]::UTF8) } catch {}
    }
    return $text.Trim()
}

# ---------- HTTP 客户端 ----------
$global:http = New-Object System.Net.Http.HttpClient
$global:http.Timeout = [TimeSpan]::FromSeconds(120)
$authHeader = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($global:cfg.AuthUser):$($global:cfg.AuthPassword)"))
$global:http.DefaultRequestHeaders.Add('Authorization', $authHeader)

# ---------- 历史 ----------
$global:history = New-Object System.Collections.ArrayList

function global:Load-History {
    try {
        $resp = $global:http.GetStringAsync("$($global:cfg.ServerUrl)/liao/current?limit=80").Result
        $json = $resp | ConvertFrom-Json
        if ($json.messages) {
            $global:history.Clear()
            foreach ($m in $json.messages) {
                $null = $global:history.Add(@{ role = [string]$m.role; content = [string]$m.content })
            }
        }
    } catch {}
}

# ---------- TTS 播放 ----------
$global:wmp = $null
function global:Get-Player {
    if ($null -eq $global:wmp) {
        $global:wmp = New-Object -ComObject WMPlayer.OCX
        $global:wmp.settings.volume = 100
    }
    return $global:wmp
}

function global:Speak-Text([string]$text) {
    $text = [string]$text
    if (-not $text.Trim()) { return }
    $url = "$($global:cfg.ServerUrl)/liao/tts?text=" + [Uri]::EscapeDataString($text)
    $tmp = Join-Path $env:TEMP ("xiaomiao_" + [guid]::NewGuid().ToString('N') + ".mp3")
    try {
        $bytes = $global:http.GetByteArrayAsync($url).Result
        [System.IO.File]::WriteAllBytes($tmp, $bytes)
        $player = Get-Player
        $player.URL = $tmp
        $player.controls.play()
        # 等待播放完成。playState: 3=Playing, 8=MediaEnded, 1=Stopped
        $waitStart = [DateTime]::Now
        $started = $false
        while ($true) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 80
            $st = 0
            try { $st = $player.playState } catch {}
            if ($st -eq 3) { $started = $true }                 # 进入播放状态
            if ($started -and ($st -eq 8 -or $st -eq 1)) { break }  # 播完
            if (([DateTime]::Now - $waitStart).TotalSeconds -gt 60) { break }
        }
        try { [System.IO.File]::Delete($tmp) } catch {}
    } catch {}
}

# ---------- 核心对话 ----------
function global:Send-And-Speak([string]$userText) {
    $global:form.SetState('sending', [char]0x22EF)  # ⋯

    $null = $global:history.Add(@{ role = 'user'; content = $userText })
    while ($global:history.Count -gt ($global:cfg.HistoryTurns * 2)) { $global:history.RemoveAt(0) }

    $payload = @{
        notes = @{ about_you = @(); how_to_talk = @(); between_us = @(); about_me = @() }
        messages = @($global:history | Select-Object -Last $global:cfg.HistoryTurns)
    }
    $json = $payload | ConvertTo-Json -Depth 10 -Compress

    try {
        $req = New-Object System.Net.Http.HttpRequestMessage
        $req.Method = [System.Net.Http.HttpMethod]::Post
        $req.RequestUri = "$($global:cfg.ServerUrl)/liao/chat"
        $req.Content = New-Object System.Net.Http.StringContent($json, [Text.Encoding]::UTF8, 'application/json')

        $response = $global:http.SendAsync($req).Result
        if (-not $response.IsSuccessStatusCode) {
            $global:form.SetState('error', '!')
            Start-Sleep -Milliseconds 800
            $global:form.SetState('idle', '')
            return
        }

        # 后端 SSE 会在 done 后 end，所以 ReadAsStringAsync 能拿到完整响应体
        $body = $response.Content.ReadAsStringAsync().Result
        $response.Dispose(); $req.Dispose()

        # 解析 SSE：按行取 data: 后的 JSON
        $allBubbles = New-Object System.Collections.ArrayList
        foreach ($line in ($body -split "`n")) {
            $line = $line.Trim()
            if (-not $line.StartsWith('data:')) { continue }
            $data = $line.Substring(5).Trim()
            if (-not $data -or $data -eq '[DONE]') { continue }
            try { $evt = $data | ConvertFrom-Json } catch { continue }

            switch ([string]$evt.type) {
                'bubble' {
                    $txt = [string]$evt.text
                    $null = $allBubbles.Add($txt)
                }
                'error' {
                    $global:form.SetState('error', '!')
                }
                'wait' {
                    $global:form.SetState('sending', [char]0x22EF)
                }
                'thinking' {
                    if ($allBubbles.Count -eq 0) { $global:form.SetState('sending', [char]0x22EF) }
                }
            }
        }

        # 逐句 TTS 播放（她说时图标隐藏；等上一句播完再播下一句）
        foreach ($b in $allBubbles) {
            $txt = [string]$b
            $null = $global:history.Add(@{ role = 'assistant'; content = $txt })
            $global:form.SetState('speaking', '')
            Speak-Text $txt
            [System.Windows.Forms.Application]::DoEvents()
        }

        if ($allBubbles.Count -gt 0) {
            # 她说完 → 再监听几秒
            $global:form.SetState('again', [char]0x25CF)
            Start-Listening
            $followup = Wait-Speech $global:cfg.AfterSpeakListen
            Stop-Listening
            if ($followup) {
                Send-And-Speak $followup
                return
            }
        }
        $global:form.SetState('idle', '')

    } catch {
        $global:form.SetState('reconnect', [char]0x21BB)  # ↻
        Start-Sleep -Seconds 2
        $global:form.SetState('idle', '')
    }
}

# ---------- 主流程 ----------
# 全局未处理异常记录到临时日志（不弹窗打扰）
$global:errLog = Join-Path $env:TEMP 'xiaomiao_presence_err.log'

$global:form = New-Object PresenceForm($global:cfg.IconSize)
$global:caption = New-Object CaptionForm

# 位置：屏幕右上角
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$global:form.Left = $scr.Right - $global:form.Width - $global:cfg.IconMargin
$global:form.Top = $scr.Top + $global:cfg.IconMargin

# 文字标签位置：图标下方（图标底边往下一点，右对齐）
$global:caption.Left = $scr.Right - $global:caption.Width - $global:cfg.IconMargin
$global:caption.Top = $global:form.Top + $global:form.Height + 6
$global:caption.Visible = $false

# 注册热键
$hk = Parse-Hotkey $global:cfg.Hotkey
$vk = Get-VirtualKey $hk.Key
if ($vk -eq 0) {
    Write-Host "无效快捷键：$($global:cfg.Hotkey)" -ForegroundColor Red
    exit 1
}
$hotkeyId = 9001
$reg = [PresenceForm]::RegisterHotKey($global:form.Handle, $hotkeyId, $hk.Mods, $vk)
if (-not $reg) {
    Write-Host "热键注册失败（可能被占用）：$($global:cfg.Hotkey)" -ForegroundColor Red
}

# 热键处理（主循环轮询 C# 标志，全部在主线程执行，无跨线程问题）
$global:busy = $false

# 提示音：让用户明确知道每个阶段。用 Console.Beep（系统提示音，不占音频设备）
function global:Beep-Start { try { [System.Console]::Beep(880, 90) } catch {} }   # 短高音：开始听
function global:Beep-Got  { try { [System.Console]::Beep(1320, 80); [System.Console]::Beep(1320, 80) } catch {} }  # 双高音：识别到字，发送
function global:Beep-Miss { try { [System.Console]::Beep(330, 220) } catch {} }  # 长低音：没听到话

# 状态追踪日志（排查进程无痕退出的关键）：每次关键步骤写一行
$global:traceLog = Join-Path $env:TEMP 'xiaomiao_presence_trace.log'
function global:Trace([string]$msg) {
    try { [System.IO.File]::AppendAllText($global:traceLog, "$(Get-Date -Format 'HH:mm:ss.fff') $msg`r`n", [System.Text.Encoding]::UTF8) } catch {}
}

function global:Handle-Hotkey {
    if ($global:busy) { Trace 'hotkey: 忙碌中，忽略'; return }
    $global:busy = $true
    Trace 'hotkey: 开始处理'
    try {
        Beep-Start
        Trace 'hotkey: Beep-Start 完成'
        Start-Listening
        Trace 'hotkey: Start-Listening 完成，进入录音'
        $text = Wait-Speech $global:cfg.ListenMaxSec
        Trace "hotkey: Wait-Speech 结束，text=[$text]"
        Stop-Listening
        Trace 'hotkey: Stop-Listening 完成'
        if ($text) {
            Beep-Got
            Trace 'hotkey: 识别到内容，发送'
            Send-And-Speak $text
            Trace 'hotkey: Send-And-Speak 返回'
        } else {
            Beep-Miss
            Trace 'hotkey: 没听到话，回空闲'
            $global:form.SetState('idle', '')
        }
    } catch {
        Trace "hotkey: 异常: $_"
    } finally {
        $global:busy = $false
        Trace 'hotkey: 结束'
    }
}

$global:form.SetState('idle', '')
$global:form.Show()
# 预创建文字标签句柄（先显示再隐藏，避免第一次显示时的延迟/异常）
$global:caption.Show()
$global:caption.Hide()
$global:caption.Visible = $false

# 同步加载历史（本地 HTTP 很快，避免后台线程并发写 history）
Load-History

Write-Host "小喵在场陪伴已启动。按 $($global:cfg.Hotkey) 说话，Ctrl+C 退出。" -ForegroundColor Green

# 消息循环：处理 UI 事件 + 轮询热键标志
try {
    while ($true) {
        try {
            [System.Windows.Forms.Application]::DoEvents()
            if ($global:form.HotkeyTriggered) {
                $global:form.HotkeyTriggered = $false
                Handle-Hotkey
            }
        } catch {
            try { [System.IO.File]::AppendAllText($global:errLog, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $_`r`n", [System.Text.Encoding]::UTF8) } catch {}
        }
        Start-Sleep -Milliseconds 30
    }
} finally {
    Stop-Listening
    [PresenceForm]::UnregisterHotKey($global:form.Handle, $hotkeyId)
}
