@echo off
REM ===========================================================================
REM Push this repository to GitHub. Does only that.
REM
REM   push-to-github.bat git@github.com:USER/REPO.git [branch]
REM
REM Pure .bat, no bash and no Git-for-Windows dependency beyond `git` itself.
REM This is the Windows-native implementation; push-to-github.sh still exists
REM for Linux/macOS/CI, and ops/handoff/selftest.py asserts the two agree on
REM exit codes so they cannot drift apart unnoticed.
REM
REM WHY THIS FILE IS NOT ASCII-ONLY
REM -------------------------------
REM The .cmd launchers next to this file must be pure ASCII, because cmd.exe
REM decodes them with the OEM code page and mis-executes non-ASCII bytes.
REM This file is DIFFERENT: it is .bat with Chinese output, and it survives
REM because it switches the console to UTF-8 (chcp 65001) as its first real
REM action and is saved as UTF-8 without BOM.
REM
REM That combination is fragile in a way ASCII is not, so it was measured
REM rather than assumed:
REM
REM   * It is UTF-8, NO BOM. A BOM makes cmd.exe print nothing and exit 0.
REM   * It is CRLF. LF-only makes cmd.exe execute comment text as commands.
REM   * The chcp happens BEFORE any Chinese line is parsed.
REM
REM If this file is ever edited into mojibake, set it back to ASCII and move
REM the Chinese into a separate message file rather than guessing at an
REM encoding. selftest.py checks the BOM/CRLF half of the contract.
REM
REM Exit codes: 0 success; 1 check or push failed; 2 usage error.

setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1

REM Capture this script's own directory BEFORE any pushd/popd. `%~dp0` is
REM expanded when a line is PARSED, so a later `call "%~dp0_x.cmd"` after a
REM `popd` would resolve against whatever directory is current then. See the
REM longer note in upload-to-server.bat for the measured failure.
set "SCRIPT_DIR=%~dp0"

set "RC=0"

REM --- 0. arguments ----------------------------------------------------------
if "%~1"=="" goto :usage
if not "%~3"=="" goto :usage

set "REMOTE_URL=%~1"
set "BRANCH=%~2"
if "%BRANCH%"=="" set "BRANCH=main"

REM --- repository root -------------------------------------------------------
REM Resolve via git so the script works from any subdirectory. The path may
REM contain spaces or Chinese characters, so it is always quoted.
for /f "usebackq delims=" %%R in (`git rev-parse --show-toplevel 2^>nul`) do set "REPO_ROOT=%%R"
if not defined REPO_ROOT (
  echo 错误：当前目录不是一个 git 仓库。请在仓库内运行本脚本。>&2
  set "RC=1"
  goto :end
)

pushd "%REPO_ROOT%" >nul 2>&1
if errorlevel 1 (
  echo 错误：无法进入仓库根目录：%REPO_ROOT%>&2
  set "RC=1"
  goto :end
)

echo 仓库:   %REPO_ROOT%
echo 远端:   %REMOTE_URL%
echo 分支:   %BRANCH%
echo.

REM --- 1. the remote must look like SSH --------------------------------------
REM HTTPS is refused deliberately: it triggers an interactive credential prompt,
REM which inside an automated script looks like a hang rather than an error.
echo %REMOTE_URL% | findstr /b /c:"git@" >nul 2>&1
if not errorlevel 1 goto :remote_ok
echo %REMOTE_URL% | findstr /b /c:"ssh://" >nul 2>&1
if not errorlevel 1 goto :remote_ok
echo %REMOTE_URL% | findstr /b /c:"https://" >nul 2>&1
if not errorlevel 1 (
  echo 错误：这是 HTTPS 地址。请改用 SSH 形式：git@github.com:用户名/仓库名.git>&2
  set "RC=1"
  goto :end
)
echo 错误：无法识别的远端地址（应为 git@github.com:用户名/仓库名.git）：%REMOTE_URL%>&2
set "RC=1"
goto :end
:remote_ok

REM `git@` alone is not enough -- it must carry a colon separating host and path.
echo %REMOTE_URL% | findstr /c:"@" /c:":" >nul 2>&1
if errorlevel 1 (
  echo 错误：无法识别的远端地址（应为 git@github.com:用户名/仓库名.git）：%REMOTE_URL%>&2
  set "RC=1"
  goto :end
)

REM --- 2. branch must exist locally ------------------------------------------
git rev-parse --verify --quiet "refs/heads/%BRANCH%" >nul 2>&1
if errorlevel 1 (
  for /f "usebackq delims=" %%C in (`git rev-parse --abbrev-ref HEAD 2^>nul`) do set "CUR=%%C"
  echo 错误：本地没有分支 %BRANCH%。当前分支是 !CUR!。>&2
  set "RC=1"
  goto :end
)

REM Refuse to push a branch other than the checked-out one. This is the trap
REM where you believe you are pushing the code in front of you, but you are
REM pushing an older commit from a different branch.
for /f "usebackq delims=" %%C in (`git rev-parse --abbrev-ref HEAD 2^>nul`) do set "CURRENT=%%C"
if not "%CURRENT%"=="%BRANCH%" (
  echo 错误：当前在分支 %CURRENT% 上，但你要求推 %BRANCH%。请先 git switch %BRANCH%，或把分支参数写成 %CURRENT%。>&2
  set "RC=1"
  goto :end
)

REM --- 3. the working tree must be clean -------------------------------------
REM Untracked files are allowed; changes to TRACKED files are not, because they
REM make it impossible to tell what was actually pushed.
git diff --quiet
if errorlevel 1 goto :dirty
git diff --cached --quiet
if errorlevel 1 goto :dirty
goto :clean

:dirty
echo 已跟踪文件里有未提交的改动：>&2
git status --short >&2
echo 错误：请先提交或 stash 改动，再推送。>&2
set "RC=1"
goto :end

:clean

REM --- 4. credential files must never be committed ---------------------------
REM Checked against `git ls-files` -- what git would actually push -- rather
REM than the filesystem: .gitignore making a file exist but stay untracked is
REM exactly the desired state, so scanning the disk would produce false alarms.
REM
REM The rule, matching the .sh: a file is a credential file when its NAME is
REM exactly ".env", or begins with ".env." and is not a ".example" template.
REM
REM Plain string comparison, NOT findstr. findstr treats "." as a wildcard, so
REM an earlier revision's `findstr /i /e /c:".example"` did not let the
REM templates through and this guard flagged .env.example, contracts/.env.example
REM and web/.env.example -- all three of which are SUPPOSED to be committed.
REM It stopped a real push of this repository. A guard that refuses to do the
REM thing it was written to do is worse than no guard: it trains people to
REM bypass it. The .sh version of this check had the same bug once, in the
REM other direction, which is exactly why the two are asserted to agree.
set "LEAKED=0"
for /f "usebackq delims=" %%F in (`git ls-files`) do (
  set "F=%%F"
  REM `!F!` needs delayed expansion, hence EnableDelayedExpansion above.
  for %%B in ("!F!") do set "FBASE=%%~nxB"
  set "CRED=0"
  if /i "!FBASE!"==".env" set "CRED=1"
  if /i "!FBASE:~0,5!"==".env." if /i not "!FBASE:~-8!"==".example" set "CRED=1"
  if "!CRED!"=="1" (
    echo   被跟踪的凭据文件: !F!>&2
    set "LEAKED=1"
  )
)
if "%LEAKED%"=="1" (
  echo 错误：有 .env 文件被 git 跟踪，推送会把真实凭据发到 GitHub。请先 git rm --cached 它们。>&2
  set "RC=1"
  goto :end
)

REM A normal filename does not make the CONTENT safe: a key can be pasted into
REM any tracked file. Look for values that look real, not placeholders.
git grep -qE "^SEPOLIA_PRIVATE_KEY=0x[0-9a-fA-F]{64}" -- . >nul 2>&1
if not errorlevel 1 (
  echo   命中：某个被跟踪文件里有 SEPOLIA_PRIVATE_KEY=0x^<64位十六进制^>>&2
  echo 错误：被跟踪文件里有明文私钥。>&2
  set "RC=1"
  goto :end
)

echo 检查通过。
echo.

REM --- 5. configure the remote, then push ------------------------------------
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin "%REMOTE_URL%"
) else (
  for /f "usebackq delims=" %%U in (`git remote get-url origin`) do set "EXISTING=%%U"
  if not "!EXISTING!"=="%REMOTE_URL%" (
    echo origin 原本是 !EXISTING!，改为 %REMOTE_URL%
    git remote set-url origin "%REMOTE_URL%"
  )
)

echo 推送中（不使用 --force）...
REM -u makes the branch track the remote. NEVER --force: it would erase a
REM concurrent line of work in this repository.
git push -u origin "%BRANCH%"
if errorlevel 1 (
  echo 错误：推送失败。>&2
  set "RC=1"
  goto :end
)

echo.
echo 完成。
echo 接下来在 GitHub 仓库的 Settings → Secrets and variables → Actions 里填变量与密钥，
echo 清单见 deploy-env/github-actions.txt。
goto :end

:usage
echo 用法: ops\handoff\push-to-github.bat ^<远端地址^> [分支]>&2
echo.>&2
echo   远端地址   形如 git@github.com:用户名/仓库名.git>&2
echo   分支       默认 main>&2
echo.>&2
echo 示例:>&2
echo   ops\handoff\push-to-github.bat git@github.com:zhangsan/decentralized-voting-dapp.git>&2
echo   ops\handoff\push-to-github.bat git@github.com:zhangsan/decentralized-voting-dapp.git main>&2
set "RC=2"

:end
if defined REPO_ROOT popd >nul 2>&1

REM A double-clicked window closes the instant this ends. Pause only in that
REM case; pausing for a programmatic caller would hang automation.
call "%SCRIPT_DIR%_pause-if-doubleclicked.cmd"
if defined PAUSE_NEEDED pause

endlocal & exit /b %RC%
