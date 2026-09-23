@echo off
REM Windows 启动器：把仓库推送到 GitHub。可双击，也可在 PowerShell/cmd 里运行。
REM
REM   push-to-github.cmd git@github.com:用户名/仓库名.git
REM
REM 真正的逻辑在 push-to-github.sh。这里只做三件事：找到 Git 的 bash、
REM 切到仓库根目录、把参数原样转交。刻意不在 .cmd 里重写一份逻辑 ——
REM 两份实现一定会漂移，而 CI 上跑的是 .sh 那一份（还有 shellcheck 盯着它）。

setlocal EnableExtensions
set "RC=0"

call "%~dp0_bash-path.cmd"

if not defined BASH_EXE (
  echo.
  echo 错误：找不到 Git 的 bash.exe。
  echo.
  echo 这两个脚本需要 Git for Windows 自带的 bash。请先安装 Git for Windows：
  echo   https://git-scm.com/download/win
  echo.
  echo 安装后重新打开一个窗口再试。注意本机 PATH 里的 bash 是 WSL 的入口
  echo （C:\Windows\system32\bash.exe），那个不能用，本脚本会跳过它。
  echo.
  set "RC=1"
  goto :end
)

REM 切到仓库根（本文件在 ops\handoff\ 下）。用相对路径转交脚本名，
REM 避免把带中文的绝对路径交给 bash —— 那会牵扯代码页，而相对路径不牵扯。
pushd "%~dp0..\.." >nul 2>&1
if errorlevel 1 (
  echo 错误：无法进入仓库根目录：%~dp0..\..
  set "RC=1"
  goto :end
)

"%BASH_EXE%" ops/handoff/push-to-github.sh %*
set "RC=%ERRORLEVEL%"
popd

if not "%RC%"=="0" (
  echo.
  echo 脚本退出码：%RC%
)

:end
REM 双击运行时窗口会立刻关掉，看不到输出。只有在双击的情况下才暂停；
REM 从已有的 shell 里调用时不暂停，否则会挂住自动化。
echo %cmdcmdline% | find /i "%~nx0" >nul 2>&1
if not errorlevel 1 pause

endlocal & exit /b %RC%
