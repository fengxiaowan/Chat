' Guardian: keep the standalone chat service on 8788 alive (no DSH needed).
' Probes 127.0.0.1:8788 every 30 seconds; launches start.vbs if offline.
' ASCII only: wscript parses this file as ANSI, so no non-ASCII text here.

Option Explicit

Dim startVbs, port
startVbs = "C:\Users\lyy44\Documents\deepseek-harness\default-workspace\companion-standalone\start.vbs"
port = 8788

Dim sh
Set sh = CreateObject("WScript.Shell")

Call EnsureRunning()

Do While True
    WScript.Sleep 30000
    Call EnsureRunning()
Loop

Sub EnsureRunning()
    If Not IsOnline() Then
        sh.Run "wscript.exe """ & startVbs & """", 0, False
        WScript.Sleep 3000
    End If
End Sub

Function IsOnline()
    On Error Resume Next
    Dim xhr
    Set xhr = CreateObject("MSXML2.XMLHTTP")
    xhr.open "GET", "http://127.0.0.1:" & port & "/liao", False
    xhr.setRequestHeader "Cache-Control", "no-cache"
    xhr.send ""
    If Err.Number = 0 Then
        IsOnline = True
    Else
        IsOnline = False
    End If
    Err.Clear
    On Error GoTo 0
    Set xhr = Nothing
End Function
