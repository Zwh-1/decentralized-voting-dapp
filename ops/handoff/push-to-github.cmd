@echo off
REM ---------------------------------------------------------------------------
REM Windows launcher: push this repository to GitHub.
REM Double-clickable, and usable from PowerShell or cmd.
REM
REM   push-to-github.cmd git@github.com:USER/REPO.git
REM
REM THIS FILE IS DELIBERATELY PURE ASCII. All Chinese output comes from the .sh.
REM See the long explanation in _bash-path.cmd: the console here is code page 936,
REM so a UTF-8 .cmd is both garbled and partly executed as commands. ASCII parses
REM identically under every code page; bytes printed by Git bash pass through cmd
REM unchanged, which was measured under both 936 and 65001.
REM
REM The real logic lives in push-to-github.sh. This does three things: find Git's
REM bash, switch to the repository root, and forward the arguments unchanged.
REM It deliberately does NOT carry its own usage text or argument validation --
REM an earlier revision duplicated the usage text and the two copies disagreed:
REM the .cmd returned 0 on a usage error where the .sh returned 2.
REM
REM WATCH OUT for parentheses inside a `( ... )` block. One of the messages below
REM used to read "the WSL entry point (C:\Windows\system32\bash.exe), which does
REM not work" -- the ) in "bash.exe)" closed the enclosing if-block early, the
REM leftover ", which does not work on" was executed as a command, and every run
REM died with "which was unexpected at this time." before printing anything.
REM Keep blocks free of stray parentheses, or escape them as ^( and ^).

setlocal EnableExtensions
set "RC=0"

REM Make the console render UTF-8, which is what Git bash emits. Without this the
REM Chinese output from the .sh arrives intact but is painted as mojibake.
chcp 65001 >nul 2>&1

call "%~dp0_bash-path.cmd"

if not defined BASH_EXE (
  echo.
  echo ERROR: could not find Git's bash.exe
  echo.
  echo These scripts need the bash that ships with Git for Windows. Install it from:
  echo   https://git-scm.com/download/win
  echo.
  echo Then open a new window and try again. Note that the bash on PATH here is
  echo the WSL entry point at C:\Windows\system32\bash.exe, which does not work
  echo on this machine; this launcher skips it on purpose.
  echo.
  set "RC=1"
  goto :end
)

REM Change to the repository root (this file lives in ops\handoff\). The script
REM name is forwarded as a relative path so bash never sees the absolute path,
REM which contains non-ASCII characters and would drag the code page into it.
pushd "%~dp0..\.." >nul 2>&1
if errorlevel 1 (
  echo ERROR: could not enter the repository root: %~dp0..\..
  set "RC=1"
  goto :end
)

"%BASH_EXE%" ops/handoff/push-to-github.sh %*
set "RC=%ERRORLEVEL%"
popd

if not "%RC%"=="0" (
  echo.
  echo script exit code: %RC%
)

:end
REM A double-clicked window closes the moment the script ends, hiding all output.
REM Pause only in that case: pausing when invoked from an existing shell would
REM hang any automation that calls this.
REM
REM The decision is made in _pause-if-doubleclicked.cmd, which asks Windows
REM whether this cmd.exe was started by explorer.exe. The previous revision
REM instead pattern-matched cmdcmdline for `/c "` -- a guess about a string
REM Explorer builds, tested only against a hand-written imitation of a
REM double-click. See that file for the measurements.
call "%~dp0_pause-if-doubleclicked.cmd"
if defined PAUSE_NEEDED pause

endlocal & exit /b %RC%
