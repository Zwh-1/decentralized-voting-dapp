@echo off
REM 定位一个可用的 bash，结果放进 BASH_EXE；找不到就留空。
REM
REM 为什么不能直接用 `bash`：在这台机器上 `bash` 解析到
REM C:\Windows\system32\bash.exe，那是 WSL 的入口，而 WSL 因为
REM VirtualMachinePlatform 未启用是坏的 —— 报的是内核错误，与本项目无关。
REM 实测：`bash -c 'echo hello'` 退出码 -1 并打印乱码，
REM 而 Git 的 bash 正常返回 0。这个区别必须由启动器处理掉，
REM 否则使用者会去排查一个根本不存在的问题。
REM
REM 逐个显式检查而不是遍历 PATH：这样路径里带空格与括号（Program Files (x86)）
REM 都不会出问题，而 for 循环里带括号的变量名会直接破坏语法。

set "BASH_EXE="

if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH_EXE=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles%\Git\usr\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\usr\bin\bash.exe"

REM 最后才退回 PATH，而且明确排除 System32 那个 WSL 入口。
if not defined BASH_EXE (
  for /f "delims=" %%P in ('where bash 2^>nul') do (
    if not defined BASH_EXE (
      echo %%P | find /i "\System32\bash.exe" >nul || set "BASH_EXE=%%P"
    )
  )
)

exit /b 0
