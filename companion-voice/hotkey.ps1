# 小喵 · 全局热键（默认 Ctrl+F1）
# 按下时写信号文件，voice-presence.mjs 轮询到就切换「通话模式」。
# 用隐藏的 message-only 窗口，不依赖 Form 的显示逻辑，消息循环稳定。

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
        public MsgWindow() {
            CreateHandle(new CreateParams());
        }
        protected override void WndProc(ref Message m) {
            if (m.Msg == WM_HOTKEY) { var h = Pressed; if (h != null) h(); return; }
            base.WndProc(ref m);
        }
    }

    public static MsgWindow Start(uint mods, uint vk, Action pressed) {
        var w = new MsgWindow();
        w.Pressed += pressed;
        if (!RegisterHotKey(w.Handle, 1, mods, vk))
            throw new InvalidOperationException("RegisterHotKey failed (may be taken by another app)");
        return w;
    }
}
"@

$signal = Join-Path $env:TEMP 'xiaomiao-voice\hotkey.signal'
$null = New-Item -ItemType Directory -Force -Path (Split-Path $signal)

$mods = 0x2   # Ctrl
$vk = 0x70    # F1

$null = [HotkeyHost]::Start($mods, $vk, {
    try { Set-Content -Path $signal -Value ([DateTime]::UtcNow.Ticks) -Encoding UTF8 } catch {}
})

Write-Output "热键已注册：Ctrl+F1"

# 跑标准消息循环，保活
[System.Windows.Forms.Application]::Run()
