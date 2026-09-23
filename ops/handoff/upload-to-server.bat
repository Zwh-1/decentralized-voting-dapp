@echo off
REM ===========================================================================
REM Upload the files a deployment server needs. Upload only -- runs NO command
REM on the server.
REM
REM   upload-to-server.bat <user@host> [--port N] [--dest PATH] [--dry-run]
REM
REM Pure .bat, no bash and no Git-for-Windows dependency beyond `git`, `tar`
REM and the OpenSSH client that ships with Windows.
REM
REM WHY UPLOAD AND DEPLOY ARE SPLIT
REM -------------------------------
REM An "upload and deploy" script would ssh in and run commands. That means the
REM script executes arbitrary operations on the server as you; every step
REM depends on a remote environment (is docker there? is envsubst? are the
REM paths right?) that cannot be verified from here; and there is no way to
REM stop between "the files are there" and "the service is up" to look. So this
REM script transfers, and prints what to run next. Unpacking is your action.
REM
REM WHY THIS FILE IS NOT ASCII-ONLY
REM -------------------------------
REM Unlike the .cmd launchers, this file is .bat with Chinese output, which
REM works because it sets the console to UTF-8 (chcp 65001) before any Chinese
REM line is parsed and is saved UTF-8 without BOM, with CRLF endings. Verified,
REM not assumed -- see the longer note in push-to-github.bat.
REM
REM Exit codes: 0 success; 1 failure; 2 usage error.

setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1

REM Capture this script's own directory BEFORE anything changes the working
REM directory. `%~dp0` is expanded when a line is PARSED, not when it runs, so
REM `call "%~dp0_x.cmd"` written after a `popd` resolves against the directory
REM in effect at that moment. Measured, from the repository root:
REM   '"...\decentralized-voting-dapp\_pause-if-doubleclicked.cmd"' is not
REM   recognized as an internal or external command
REM -- the repository root instead of ops\handoff. Storing it up front makes the
REM later call independent of the current directory.
set "SCRIPT_DIR=%~dp0"
set "RC=0"

REM --- what gets uploaded (relative to the repository root) ------------------
REM Deliberately excluded: web\, contracts\, node_modules\, any .env. The
REM service runs in a container on the server and the image carries the
REM application code; the server needs only orchestration and ops scripts.
REM
REM deploy-env sends server.env ALONE, not the whole directory: the sibling
REM github-actions.txt is a checklist for the GitHub web UI, irrelevant to the
REM server, and shipping it only puts an unusable document on the box. What a
REM directory holds and what gets transmitted are two different questions.
set "PAYLOAD=docker-compose.yml docker-compose.prod.yml ops deploy-env/server.env .env.example"

REM --- arguments -------------------------------------------------------------
if "%~1"=="" goto :usage
set "TARGET=%~1"
shift

set "PORT=22"
set "DEST=/srv/voting"
set "DRY_RUN=0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--port" (
  if "%~2"=="" (
    echo 错误：--port 后面要给一个端口号>&2
    set "RC=1"
    goto :end
  )
  set "PORT=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="--dest" (
  if "%~2"=="" (
    echo 错误：--dest 后面要给一个路径>&2
    set "RC=1"
    goto :end
  )
  set "DEST=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="--dry-run" (
  set "DRY_RUN=1"
  shift
  goto :parse_args
)
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="--help" goto :usage
echo 错误：不认识的参数：%~1>&2
set "RC=1"
goto :end

:args_done

REM --- validate arguments ----------------------------------------------------
echo %TARGET% | findstr /c:"@" >nul 2>&1
if errorlevel 1 (
  echo 错误：目标要写成 user@host 形式，收到的是：%TARGET%>&2
  set "RC=1"
  goto :end
)

echo %PORT%| findstr /r /c:"^[0-9][0-9]*$" >nul 2>&1
if errorlevel 1 (
  echo 错误：端口必须是数字，收到的是：%PORT%>&2
  set "RC=1"
  goto :end
)

REM A leading character check, since /srv/voting is POSIX. cmd has no clean
REM startswith, so compare the first character against a slash.
if not "%DEST:~0,1%"=="/" (
  echo 错误：远端目录要用绝对路径，收到的是：%DEST%>&2
  set "RC=1"
  goto :end
)

REM --- required tools --------------------------------------------------------
where git >nul 2>&1
if errorlevel 1 (
  echo 错误：找不到 git。本机需要 Git for Windows。>&2
  set "RC=1"
  goto :end
)
where tar >nul 2>&1
if errorlevel 1 (
  echo 错误：找不到 tar。Windows 10 1803 以后自带 tar。>&2
  set "RC=1"
  goto :end
)
where scp >nul 2>&1
if errorlevel 1 (
  echo 错误：找不到 scp。Windows 10 1809 以后自带 OpenSSH 客户端。>&2
  set "RC=1"
  goto :end
)
where ssh >nul 2>&1
if errorlevel 1 (
  echo 错误：找不到 ssh。Windows 10 1809 以后自带 OpenSSH 客户端。>&2
  set "RC=1"
  goto :end
)

REM --- repository root -------------------------------------------------------
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

REM --- 1. do these paths exist? ----------------------------------------------
REM Collected first and reported together, rather than transmitting half and
REM only then discovering a missing path.
set "MISSING="
set "PRESENT="
for %%P in (%PAYLOAD%) do (
  if exist "%%P" (
    set "PRESENT=!PRESENT! %%P"
  ) else (
    set "MISSING=!MISSING! %%P"
  )
)
if defined MISSING (
  echo 仓库里缺少下列路径：>&2
  for %%M in (!MISSING!) do echo   %%M>&2
  echo 错误：无法继续。>&2
  set "RC=1"
  goto :end
)

REM --- 2. never transmit real credentials ------------------------------------
REM The most important part of this script. A .env holding real values must be
REM created by hand on the server: through scp it would pass a local temp file,
REM the SSH session, and an intermediate location on the remote disk. Creating
REM it by hand writes it to disk exactly once.
REM
REM Checked against WHAT GIT WOULD PACK (`git ls-files`), not the files on disk.
REM The distinction is required: the archive comes from `git archive HEAD`,
REM which sees committed content only. Scanning the disk with `dir` would flag
REM an untracked .env that is never transmitted, and a guard that cries wolf
REM gets ignored.
REM
REM Match the FILENAME, not a suffix of the whole path: an earlier version
REM matched `\.env$` and so also caught deploy-env/server.env -- a template
REM that is SUPPOSED to be uploaded. That guard refused to send a file it was
REM explicitly meant to send.
set "LEAKED="
for /f "usebackq delims=" %%F in (`git ls-files -- %PRESENT% 2^>nul`) do (
  set "F=%%F"
  for %%B in ("!F!") do set "FBASE=%%~nxB"
  REM The rule, matching the .sh: a file is a credential file when its NAME is
  REM exactly ".env", or begins with ".env." and is not a ".example" template.
  REM
  REM Plain string comparison, NOT findstr. findstr treats "." as a wildcard,
  REM and an earlier revision used `findstr /i /e /c:".example"` here to let
  REM templates through -- it matched nothing useful and the guard ended up
  REM flagging .env.example, a file it is explicitly meant to send. That is the
  REM same class of bug the .sh version already had once, in the other
  REM direction. deploy-env/server.env is a TEMPLATE whose extension happens to
  REM be .env and is allowed too; only the exact name ".env" is a credential.
  set "CRED=0"
  if /i "!FBASE!"==".env" set "CRED=1"
  if /i "!FBASE:~0,5!"==".env." if /i not "!FBASE:~-8!"==".example" set "CRED=1"
  if "!CRED!"=="1" set "LEAKED=!LEAKED! !F!"
)
if defined LEAKED (
  echo 下列含真实值的文件会被上传：>&2
  for %%L in (!LEAKED!) do echo   %%L>&2
  echo 错误：已阻止。凭据请在服务器上手工创建，不要经过传输。>&2
  set "RC=1"
  goto :end
)

REM --- 3. pack ---------------------------------------------------------------
REM `git archive` rather than tarring the directory: it packs COMMITTED content
REM only, so local scratch files, editor backups or a forgotten .env cannot ride
REM along. That is a stronger invariant than a hand-written exclude list --
REM exclude lists miss things, committed state does not.
echo 打包（只含已提交内容）...
set "TMPTAR=%TEMP%\voting-upload.tar"
if exist "%TMPTAR%" del "%TMPTAR%" >nul 2>&1

git archive --format=tar --output="%TMPTAR%" HEAD -- %PRESENT%
if errorlevel 1 (
  echo 错误：git archive 失败。>&2
  set "RC=1"
  goto :end
)

for %%S in ("%TMPTAR%") do set "BYTES=%%~zS"
echo 包大小: %BYTES% 字节

if "%DRY_RUN%"=="1" (
  echo.
  echo --dry-run：实际会传的内容如下（未传输）
  echo.
  tar -tf "%TMPTAR%"
  echo.
  echo 目标会是: %TARGET%:%DEST%/
  echo 端口:     %PORT%
  echo.
  echo 真正的命令会是:
  echo   ssh -p %PORT% %TARGET% "mkdir -p %DEST%"
  echo   scp -P %PORT% "%TMPTAR%" %TARGET%:/tmp/voting-upload.tar
  echo.
  echo （--dry-run 不会执行上面两条）
  goto :end
)

REM --- 4. transfer -----------------------------------------------------------
REM Create the directory, then send the archive. Neither runs an arbitrary
REM command on the target: mkdir is written by the script's author and takes no
REM input from the uploaded content. The archive is NOT unpacked -- that is your
REM action after logging in.
REM
REM BatchMode=yes: fail instead of prompting. A password prompt inside a script
REM looks like a hang, and this script is meant to be scriptable.
echo.
echo 建立远端目录 %DEST% ...
ssh -p %PORT% -o BatchMode=yes "%TARGET%" "mkdir -p '%DEST%'"
if errorlevel 1 (
  echo 错误：无法在远端建立目录。请确认密钥已配置（BatchMode 下不会提示输入口令）。>&2
  set "RC=1"
  goto :end
)

echo 上传中...
scp -P %PORT% -o BatchMode=yes "%TMPTAR%" "%TARGET%:/tmp/voting-upload.tar"
if errorlevel 1 (
  echo 错误：上传失败。>&2
  set "RC=1"
  goto :end
)

echo.
echo 完成。包已传到 %TARGET%:/tmp/voting-upload.tar

REM --- 5. tell the operator what to do next ----------------------------------
REM Kept as instructions rather than auto-executed. The script stops here.
echo.
echo 下一步（请自己登录服务器执行）：
echo.
echo   1. 解开包（不会覆盖已有文件，-k 让你能看到冲突而不是被静默覆盖）：
echo.
echo        cd %DEST%
echo        tar -xkvf /tmp/voting-upload.tar
echo        rm /tmp/voting-upload.tar
echo.
echo   2. 创建生产 .env（这个文件不走上传，里面有真实口令）：
echo.
echo        cd %DEST%
echo        cp .env.example .env
echo        chmod 600 .env
echo        # 然后编辑 .env，填上数据库口令等。字段说明见 deploy-env/server.env
echo.
echo   3. 构建镜像并启动：
echo.
echo        cd %DEST%
echo        docker compose -f docker-compose.yml -f docker-compose.prod.yml build
echo        docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
echo.
echo   4. 看状态：
echo.
echo        docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
echo        curl -sS localhost/api/health
echo.
echo 注意：不要使用 docker-compose.override.yml，它只用于本地开发。
echo 生产命令必须显式写出 -f docker-compose.yml -f docker-compose.prod.yml 两个文件。
goto :end

:usage
echo 用法: ops\handoff\upload-to-server.bat ^<user@host^> [选项]>&2
echo.>&2
echo   user@host        例如 deploy@203.0.113.10>&2
echo   --port N         SSH 端口，默认 22>&2
echo   --dest PATH      远端目标目录，默认 /srv/voting>&2
echo   --dry-run        只显示会传什么，不实际传输>&2
echo.>&2
echo 示例:>&2
echo   ops\handoff\upload-to-server.bat deploy@203.0.113.10>&2
echo   ops\handoff\upload-to-server.bat deploy@203.0.113.10 --port 2222 --dest /srv/voting>&2
echo   ops\handoff\upload-to-server.bat deploy@203.0.113.10 --dry-run>&2
set "RC=2"

:end
if defined REPO_ROOT popd >nul 2>&1
if defined TMPTAR if exist "%TMPTAR%" del "%TMPTAR%" >nul 2>&1

call "%SCRIPT_DIR%_pause-if-doubleclicked.cmd"
if defined PAUSE_NEEDED pause

endlocal & exit /b %RC%
