@echo off
chcp 65001 >nul
set NODE="C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set SCRIPT="C:\Users\lyy44\Documents\deepseek-harness\default-workspace\companion-proxy\proxy.js"
echo 固定入口：http://127.0.0.1:8899/liao
echo 关掉这个窗口就停止代理。
%NODE% %SCRIPT%
pause
