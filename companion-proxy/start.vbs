' 静默启动固定入口代理（不弹黑框）
' 双击这个文件即可。想开机自启，把它的快捷方式丢进 shell:startup

Dim sh, node, script
Set sh = CreateObject("WScript.Shell")
node = "C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
script = "C:\Users\lyy44\Documents\deepseek-harness\default-workspace\companion-proxy\proxy.js"
sh.Run """" & node & """ """ & script & """", 0, False
