Set shell = CreateObject("WScript.Shell")
cmd = """C:\Program Files\PowerShell\7\pwsh.exe"" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""E:\Claude Code Projects\Personal\PC-SDK-Next\launcher\pc-sdk-launcher.ps1"""
shell.Run cmd, 0, False
