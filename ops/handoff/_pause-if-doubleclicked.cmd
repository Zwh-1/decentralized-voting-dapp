@echo off
REM ---------------------------------------------------------------------------
REM Pause ONLY when this window would otherwise vanish before it can be read.
REM
REM Sets PAUSE_NEEDED=1 in the CALLER's environment when a pause is wanted.
REM No setlocal, for the same reason as _bash-path.cmd: cmd expands %VAR% while
REM parsing the line, so an endlocal-based export cannot work.
REM
REM WHY THE OLD TEST WAS REPLACED
REM -----------------------------
REM The previous revision decided this by pattern-matching cmdcmdline:
REM
REM   echo %cmdcmdline% | find /i "/c """ >nul 2>&1
REM
REM i.e. "does the command line contain /c followed by a quote". That is a guess
REM about a string Explorer builds, and it was only ever tested against a
REM hand-written `cmd /c ""<path>""` -- the form the author assumed Explorer
REM used. Explorer actually appends a trailing space, and the quoting differs
REM when the path contains spaces or non-ASCII characters (this repository sits
REM under D:\<Chinese>\..., so it does). The probe was measuring the author's
REM simulation of a double-click, not a double-click.
REM
REM WHAT IS MEASURED INSTEAD
REM ------------------------
REM In the double-click case cmd.exe is a direct child of explorer.exe. In every
REM programmatic case (PowerShell, cmd, CI, another script) it is not. That is a
REM property of HOW THE PROCESS WAS CREATED rather than of how the command line
REM happens to be spelled, so it needs no guess about quoting conventions.
REM
REM COST
REM ----
REM One PowerShell start plus one WMI query, measured at ~200 ms on this machine.
REM An earlier two-query version cost ~600 ms; the lookups are combined below.
REM wmic is not an option: it is absent on Windows 11.
REM The probe runs only when the launcher actually reaches its end, never before
REM the real work.
REM
REM FAILURE POLICY
REM --------------
REM If PowerShell is missing or the query fails, PAUSE_NEEDED stays unset and the
REM caller does not pause. A missing pause is cosmetic; a spurious pause hangs
REM automation, so failures fall to "no pause" deliberately.

set "PAUSE_NEEDED="

REM Explicit override, used by the selftest to exercise the pause path without a
REM real double click.
if defined PAUSE_ALWAYS set "PAUSE_NEEDED=1"

if not defined PAUSE_NEEDED (
  REM -File with a RELATIVE name, run from this file's own directory.
  REM
  REM Not `-File "%~dp0_parent-name.ps1"`: this repository lives under a path
  REM containing Chinese characters (D:\<Chinese>\...), and PowerShell mangles
  REM a non-ASCII path before resolving it --
  REM   Processing -File 'D:\??\????\...' failed: Illegal characters in path
  REM That failure is silent from cmd's side: the PowerShell banner still
  REM prints, the lookup yields nothing and PARENT_NAME stays empty, which is
  REM indistinguishable from "not double-clicked" -- the pause would simply
  REM never fire. Measured: the same file with a relative name, run from its
  REM own directory, works and prints the parent correctly.
  pushd "%~dp0"
  for /f "usebackq delims=" %%P in (`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File _parent-name.ps1`) do set "PARENT_NAME=%%P"
  popd
)

if not defined PAUSE_NEEDED if /i "%PARENT_NAME%"=="explorer.exe" set "PAUSE_NEEDED=1"

set "PARENT_NAME="
exit /b 0
