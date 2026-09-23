@echo off
REM ---------------------------------------------------------------------------
REM Locate a usable bash and set BASH_EXE in the CALLER's environment.
REM Leave it unset when none is found.
REM
REM THIS FILE IS DELIBERATELY PURE ASCII. Do not add non-ASCII characters.
REM
REM Why: this machine's OEM code page is 936 (GBK), and a double-clicked .cmd is
REM decoded by cmd.exe using that code page. A UTF-8 file therefore renders as
REM mojibake AND gets partially executed as commands -- the Chinese text in the
REM previous revision produced "'...' is not recognized as an internal or
REM external command" for lines that were ordinary REM comments.
REM
REM Writing the file as GBK would fix it for cp936 and break it for anyone whose
REM console is cp65001 (VS Code terminals and Windows Terminal do this). ASCII is
REM the only encoding that parses identically under every code page, so all
REM Chinese output lives in the .sh files instead: bytes printed by Git bash pass
REM through cmd unchanged, which was measured under both 936 and 65001.
REM
REM Why not just use `bash`: on this machine `bash` resolves to
REM C:\Windows\system32\bash.exe, the WSL entry point, and WSL is broken here
REM because VirtualMachinePlatform is not enabled. Measured: `bash -c "echo hi"`
REM exits -1 with a WSL kernel error, while Git's bash exits 0. That distinction
REM has to be handled here or the reader will debug a problem that is not theirs.
REM
REM Two mistakes already made here, both recorded so they are not repeated:
REM
REM 1. NO setlocal. An earlier revision used one and then tried to export the
REM    result with `endlocal & set "BASH_EXE=%BASH_EXE%"`. That cannot work: cmd
REM    expands %BASH_EXE% while parsing that line, which is before endlocal runs,
REM    so the caller always received an empty value.
REM
REM 2. NO `for %%D in ( ... )` list. The candidate paths include
REM    %ProgramFiles(x86)%, and the parentheses in "(x86)" are counted as block
REM    delimiters by cmd, so the list terminated early and the leftovers were
REM    parsed as commands -- every launcher died with
REM    "which was unexpected at this time." before printing a single line.
REM    One `if exist` per candidate has no block to be confused by.

set "BASH_EXE="

REM Each candidate is tested on its own line. A path containing spaces or
REM parentheses is fine in a quoted `if exist`; it is only inside a parenthesised
REM block that the parentheses become structural.
REM
REM %ProgramFiles(x86)% is expanded for the 32-bit install location; on a 64-bit
REM host this is a real path, and where it does not exist the test simply fails.

if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH_EXE=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles%\Git\usr\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\usr\bin\bash.exe"

REM GitHub Desktop ships its own Git under a versioned directory, so a fixed path
REM cannot reach it. The pattern is one this file controls rather than output
REM from another program, and it expands to text with no parentheses in it.
if not defined BASH_EXE (
  for /d %%V in ("%LOCALAPPDATA%\GitHubDesktop\app-*") do (
    if not defined BASH_EXE if exist "%%~V\resources\app\git\usr\bin\bash.exe" set "BASH_EXE=%%~V\resources\app\git\usr\bin\bash.exe"
  )
)

exit /b 0
