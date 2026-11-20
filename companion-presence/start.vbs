' 小喵 · 在场陪伴 启动器（无黑窗）
' 双击此文件即可后台启动，不显示命令行窗口
Set W = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\presence.ps1"
W.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """", 0, False
