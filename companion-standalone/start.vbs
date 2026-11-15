' 静默启动独立聊天服务（不依赖 DSH）
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"" ""C:\Users\lyy44\Documents\deepseek-harness\default-workspace\companion-standalone\server.js""", 0, False
