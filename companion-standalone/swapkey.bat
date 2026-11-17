@echo off
chcp 65001 >nul
set "NODE=C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "SCRIPT=C:\Users\lyy44\Documents\deepseek-harness\default-workspace\companion-standalone\swapkey.js"
"%NODE%" "%SCRIPT%"
echo.
echo Press any key to close...
pause >nul
