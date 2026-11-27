# 小喵 · 托盘控制（替代右上角常驻小球）
# 托盘右键菜单：开关语音功能、开关通话模式、退出。
# 默认【不显示任何悬浮图标】，只在系统托盘有个很小的图标。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class HotkeyHost {
    public const int WM_HOTKEY = 0x0312;
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public class MsgWindow : NativeWindow {
        public event Action Pressed;
        public MsgWindow() { CreateHandle(new CreateParams()); }
        protected override void WndProc(ref Message m) {
            if (m.Msg == WM_HOTKEY) { var h = Pressed; if (h != null) h(); return; }
            base.WndProc(ref m);
        }
    }
    public static MsgWindow Start(uint mods, uint vk, Action pressed) {
        var w = new MsgWindow();
        w.Pressed += pressed;
        if (!RegisterHotKey(w.Handle, 1, mods, vk)) throw new InvalidOperationException("hotkey failed");
        return w;
    }
}
"@

$dir      = Join-Path $env:TEMP 'xiaomiao-voice'
$null     = New-Item -ItemType Directory -Force -Path $dir
$stateF   = Join-Path $dir 'state.json'
$hotkeyF  = Join-Path $dir 'hotkey.signal'
$masterF  = Join-Path $dir 'master.json'

function Get-StateName {
  try {
    $j = Get-Content $stateF -Raw -ErrorAction Stop | ConvertFrom-Json
    return $j.state
  } catch { return 'off' }
}
function Set-Master([bool]$on) {
  @{ enabled = $on } | ConvertTo-Json -Compress | Set-Content $masterF -Encoding UTF8
}
function Get-Master {
  try {
    if (-not (Test-Path $masterF)) { return $true }
    $j = Get-Content $masterF -Raw -ErrorAction Stop | ConvertFrom-Json
    return [bool]$j.enabled
  } catch { return $true }
}

# 托盘图标：用代码画一个圆，避免依赖外部图片
function New-Dot([System.Drawing.Color]$c) {
  $bmp = New-Object System.Drawing.Bitmap 16,16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $c
  $g.FillEllipse($brush, 1, 1, 14, 14)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$iconOff = New-Dot ([System.Drawing.Color]::FromArgb(120,120,120))
$iconOn  = New-Dot ([System.Drawing.Color]::FromArgb(70,140,235))

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconOff
$tray.Text = '小喵语音（未开启）'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miMaster = New-Object System.Windows.Forms.ToolStripMenuItem
$miMaster.Text = '开启语音功能'
$menu.Items.Add($miMaster) | Out-Null

$miCall = New-Object System.Windows.Forms.ToolStripMenuItem
$miCall.Text = '通话模式（Ctrl+F1）'
$miCall.Enabled = $false
$menu.Items.Add($miCall) | Out-Null

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$miOpen.Text = '打开聊天网页'
$menu.Items.Add($miOpen) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miQuit = New-Object System.Windows.Forms.ToolStripMenuItem
$miQuit.Text = '退出（含语音服务）'
$menu.Items.Add($miQuit) | Out-Null

$tray.ContextMenuStrip = $menu

function Refresh-UI {
  $master = Get-Master
  $st = Get-StateName
  if ($master) {
    $miMaster.Text = '关闭语音功能（释放麦克风）'
    $miCall.Enabled = $true
    if ($st -eq 'off') { $miCall.Text = '进入通话模式（Ctrl+F1）' }
    else { $miCall.Text = '退出通话模式（Ctrl+F1）' }
    $tray.Icon = $iconOn
    $label = switch ($st) {
      'ready'    { '待命，等你说“老婆”' }
      'hearing'  { '正在听你说的' }
      'thinking' { '她在想' }
      'speaking' { '她正在说' }
      'error'    { '出错了' }
      default    { '通话模式关闭' }
    }
    $tray.Text = "小喵语音：$label"
  } else {
    $miMaster.Text = '开启语音功能'
    $miCall.Enabled = $false
    $miCall.Text = '通话模式（Ctrl+F1）'
    $tray.Icon = $iconOff
    $tray.Text = '小喵语音：已关闭'
  }
}

$miMaster.Add_Click({
  $on = -not (Get-Master)
  Set-Master $on
  if ($on) { $tray.ShowBalloonTip(1500, '小喵语音', '语音功能已开启。按 Ctrl+F1 进入通话模式。', 'None') }
  else { $tray.ShowBalloonTip(1500, '小喵语音', '语音功能已关闭，麦克风不会被使用。', 'None') }
  Refresh-UI
})

$miCall.Add_Click({
  if (-not (Get-Master)) { return }
  Set-Content -Path $hotkeyF -Value ([DateTime]::UtcNow.Ticks) -Encoding UTF8
  Start-Sleep -Milliseconds 400
  Refresh-UI
})

$miOpen.Add_Click({ Start-Process 'http://127.0.0.1:8899/liao' })

$miQuit.Add_Click({
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$tray.Add_MouseDoubleClick({
  if (-not (Get-Master)) { return }
  Set-Content -Path $hotkeyF -Value ([DateTime]::UtcNow.Ticks) -Encoding UTF8
  Start-Sleep -Milliseconds 400
  Refresh-UI
})

# 全局热键：Ctrl+F1
$mods = 0x2
$vk = 0x70
try {
  $null = [HotkeyHost]::Start($mods, $vk, {
    if (-not (Get-Master)) { return }
    try { Set-Content -Path $hotkeyF -Value ([DateTime]::UtcNow.Ticks) -Encoding UTF8 } catch {}
  })
} catch {}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({ Refresh-UI })
$timer.Start()

Refresh-UI
[System.Windows.Forms.Application]::Run()
