' 小喵 · 桌面语音常驻（无黑窗后台启动）
' 双击即可后台运行：说「老婆」唤醒她
Set W = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
W.Run """" & node & """ """ & dir & "\voice-presence.mjs""", 0, False
' 小喵 · 桌面语音常驻（无黑窗后台启动）
' 双击即可后台运行：说「老婆」唤醒她；右上角小圆点显示状态
Set W = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

' 先起状态球，再起语音服务
W.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\status-orb.ps1""", 0, False
W.Run """" & node & """ """ & dir & "\voice-presence.mjs""", 0, False
' 小喵 · 桌面语音（通话模式）一键启动
' 会拉起三个后台进程：状态球、全局热键、语音服务
' 默认不监听麦克风；按 Ctrl+F1 进入通话模式（再按关闭）
Set W = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

' 1) 右上角状态球
W.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\status-orb.ps1""", 0, False
' 2) 全局热键 Ctrl+F1
W.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\hotkey.ps1""", 0, False
' 3) 语音服务
W.Run """" & node & """ """ & dir & "\voice-presence.mjs""", 0, False
' 小喵 · 桌面语音一键启动
' 只会在系统托盘出现一个小图标，不会在屏幕上显示任何悬浮球。
' 右键托盘图标：开启/关闭语音功能、进入通话模式、打开聊天网页。
Set W = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

' 1) 托盘控制（含全局热键 Ctrl+F1）
W.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\tray.ps1""", 0, False
' 2) 语音服务
W.Run """" & node & """ """ & dir & "\voice-presence.mjs""", 0, False
