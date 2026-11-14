@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PY="C:\Users\lyy44\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
start "" http://127.0.0.1:8777
%PY% server.py
