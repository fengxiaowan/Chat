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
