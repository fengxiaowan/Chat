# 小喵 · 桌面语音状态球
# 屏幕右上角一个小圆点，实时显示她现在是睡着 / 在听 / 在想 / 在说。
# 数据来自 voice-presence.mjs 写的 state.json。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$stateFile = Join-Path $env:TEMP 'xiaomiao-voice\state.json'
$iconSize = 34
$margin = 16

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class OrbForm : Form {
    private int size;
    private string state = "idle";
    public string StatePath = Path.Combine(Path.GetTempPath(), "xiaomiao-voice", "state.json");

    public OrbForm(int s) {
        size = s;
        FormBorderStyle = FormBorderStyle.None;
        TopMost = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(s, s);
        var wa = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(wa.Right - s - 16, wa.Top + 16);
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint, true);
        BackColor = Color.Transparent;
        DoubleBuffered = true;
    }

    public void Tick() {
        try {
            if (File.Exists(this.StatePath)) {
                var json = File.ReadAllText(this.StatePath, Encoding.UTF8);
                var m = System.Text.RegularExpressions.Regex.Match(json, "\"state\"\\s*:\\s*\"([a-z]+)\"");
                if (m.Success) state = m.Groups[1].Value;
            }
        } catch {}
        Invalidate();
    }

    private Color GetColor() {
        switch (state) {
            case "hearing": return Color.FromArgb(230, 70, 160, 235);
            case "thinking": return Color.FromArgb(230, 235, 160, 70);
            case "speaking": return Color.FromArgb(230, 90, 200, 110);
            case "error": return Color.FromArgb(235, 220, 70, 70);
            default: return Color.FromArgb(150, 150, 150, 150);
        }
    }

    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var c = GetColor();
        int pad = 3;
        using (var b = new SolidBrush(c))
            g.FillEllipse(b, pad, pad, size - pad * 2, size - pad * 2);
        if (state != "idle") {
            using (var pen = new Pen(Color.FromArgb(90, c), 2))
                g.DrawEllipse(pen, pad - 1, pad - 1, size - pad * 2 + 2, size - pad * 2 + 2);
        }
    }
}
"@

$form = New-Object OrbForm($iconSize)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({ $form.Tick() })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
