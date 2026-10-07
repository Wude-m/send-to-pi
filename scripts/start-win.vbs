' send-to-pi: Silent Background Launcher for Windows
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
targetScript = rootDir & "\server\src\index.js"

' 0 = 隐藏黑框静默运行
WshShell.Run "cmd.exe /c node """ & targetScript & """", 0, False
