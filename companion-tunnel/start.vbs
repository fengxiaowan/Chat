' 静默启动 cloudflared 快速隧道（把电脑 8899 映射成公网网址）
' 当前公网地址会写进同目录的 cf.out.log，用这个日志找地址：
'   在其中搜 trycloudflare.com
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\lyy44\Documents\deepseek-harness\default-workspace\companion-tunnel\cloudflared.exe"" tunnel --url http://127.0.0.1:8899 --protocol http2 --logfile ""C:\Users\lyy44\Documents\deepseek-harness\default-workspace\companion-tunnel\cf.out.log"" --loglevel info", 0, False
