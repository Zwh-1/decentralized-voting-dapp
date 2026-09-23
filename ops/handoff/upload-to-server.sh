#!/usr/bin/env bash
#
# 把仓库里"部署服务器需要的那部分"上传到服务器。只上传，不在服务器上执行任何命令。
#
#   usage: ops/handoff/upload-to-server.sh <user@host> [--port N] [--dest PATH] [--dry-run]
#
# 为什么明确"不远程执行"
# ----------------------
#
# 一个"上传并部署"的脚本要 ssh 进服务器跑命令。那意味着：
#
#   * 脚本以你的身份在服务器上执行任意命令，出错的代价是服务器被改坏；
#   * 每一步都依赖远端环境（有 docker 吗？有 envsubst 吗？路径对吗？），
#     而这些在本机无从验证——失败会在服务器上以半完成状态出现；
#   * 你无法在"文件传上去了"和"服务被启动了"之间选择停下来看一眼。
#
# 所以职责切成两半：本脚本负责传输（可验证、可重复、无副作用），
# 服务器上要跑什么由你在登录后自己决定（见打印出来的下一步提示）。
#
# 本机没有 rsync（实测只有 OpenSSH 的 ssh/scp/ssh-keyscan），
# 因此传输用 scp + tar：先在本地打包，再传一个文件。这比逐文件 scp 快得多，
# 也避免了几百个小文件的中断重传问题。
#
# 退出码：0 成功；1 失败；2 用法错误。

set -euo pipefail

readonly EXIT_USAGE=2

# 上传这些（相对仓库根）。刻意不含：web/、contracts/、node_modules/、
# 任何 .env。服务器上服务跑在容器里，容器镜像自己带应用代码；
# 服务器需要的只有编排与运维脚本。
#
# deploy-env 只传 server.env 这一个文件，不传整个目录：同目录下的
# github-actions.txt 是"在 GitHub 网页上填什么"的清单，与服务器无关，
# 传上去只会让人在服务器上看到一份用不上的文档。目录放什么、传什么是两件事。
#
# docker-compose.external-db.yml 在里面，因为它是"用服务器上已有的 MySQL"那条路
# 要用的覆盖文件。不上传的话，选了那条路的人会从提示里读到一个服务器上不存在的
# 文件名——而那是他唯一拿到的包。
readonly PAYLOAD=(
  docker-compose.yml
  docker-compose.prod.yml
  docker-compose.external-db.yml
  ops
  deploy-env/server.env
  .env.example
)

die() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
用法: ops/handoff/upload-to-server.sh <user@host> [选项]

  user@host        例如 deploy@203.0.113.10
  --port N         SSH 端口，默认 22
  --dest PATH      远端目标目录，默认 /srv/voting
  --dry-run        只显示会传什么，不实际传输

示例:
  ops/handoff/upload-to-server.sh deploy@203.0.113.10
  ops/handoff/upload-to-server.sh deploy@203.0.113.10 --port 2222 --dest /srv/voting
  ops/handoff/upload-to-server.sh deploy@203.0.113.10 --dry-run
EOF
  exit "$EXIT_USAGE"
}

[ $# -ge 1 ] || usage
target=$1
shift

port=22
dest=/srv/voting
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || die "--port 后面要给一个端口号"
      port=$2
      shift 2
      ;;
    --dest)
      [ $# -ge 2 ] || die "--dest 后面要给一个路径"
      dest=$2
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      usage
      ;;
    *)
      die "不认识的参数：$1"
      ;;
  esac
done

case "$target" in
  *@*) ;;
  *) die "目标要写成 user@host 形式，收到的是：$target" ;;
esac

case "$port" in
  '' | *[!0-9]*) die "端口必须是数字，收到的是：$port" ;;
esac

[ -n "$dest" ] || die "--dest 不能为空"
case "$dest" in
  /*) ;;
  *) die "远端目录要用绝对路径，收到的是：$dest" ;;
esac

command -v scp >/dev/null || die "找不到 scp。本机需要 OpenSSH 客户端。"
command -v tar >/dev/null || die "找不到 tar。"

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  die "当前目录不是一个 git 仓库。请在仓库内运行本脚本。"
cd "$repo_root"

# --- 1. 这些路径都存在吗，而且都会被 git 打包吗 ------------------------------
# 先收集，缺任何一个就一次全报出来，而不是传一半才发现。
#
# 两个问题必须一起问，因为传输用的是 `git archive HEAD`，它只看**已提交**内容。
# 只问"磁盘上存在吗"会漏掉一种情况：路径在工作区里但从未提交。那时 git archive
# 会以 128 退出，打印 "fatal: pathspec ... did not match any files" —— 一句完全
# 没提到真正原因（忘了 git add）的话，而且退出码也不是本脚本自己的 1。
# 这里用与打包相同的口径再问一遍，把那个原因直接说出来。
missing=()
uncommitted=()
present=()
for item in "${PAYLOAD[@]}"; do
  if [ ! -e "$item" ]; then
    missing+=("$item")
  elif [ -z "$(git ls-tree -r --name-only HEAD -- "$item")" ]; then
    uncommitted+=("$item")
  else
    present+=("$item")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  printf '仓库里缺少下列路径：\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
fi

if [ ${#uncommitted[@]} -gt 0 ]; then
  printf '下列路径还没有提交，因此不会被打包：\n' >&2
  printf '  %s\n' "${uncommitted[@]}" >&2
  printf '  git archive 只打包已提交内容：先 git add 并提交，再重试。\n' >&2
fi

if [ ${#missing[@]} -gt 0 ] || [ ${#uncommitted[@]} -gt 0 ]; then
  die "无法继续。"
fi

# --- 2. 绝不把真实凭据传上去 ------------------------------------------------
# 这是本脚本最重要的一段。含真实值的 .env 必须由你在服务器上手工创建：
# 走 scp 的话它会经过本机的临时文件、SSH 会话、以及远端磁盘上的一个中间位置。
# 手工创建只有一次落盘。
#
# 检查的是 **git 会打包的内容**，而不是磁盘上的文件。这个区别是必须的：
# 传输用 `git archive HEAD`，它只看已提交内容。如果这里用 find 扫磁盘，
# 就会拦下工作区里那些**根本不会被传走**的 .env（例如刚 git rm --cached
# 但还没删的），于是脚本拒绝执行一件它其实不会做的事——一个会误报的守卫
# 比没有守卫更糟，因为它训练人忽略它。
#
# 用 git ls-files 而不是 find：既与打包口径一致，也天生排除了被忽略的文件。
leaked=()
while IFS= read -r found; do
  [ -n "$found" ] || continue
  case "$found" in
    *.example) continue ;;
  esac
  # Match the FILENAME, not a suffix of the whole path. An earlier version used
  # `\.env$`, which also matched `deploy-env/server.env` -- a template that is
  # supposed to be uploaded. The guard refused to transmit a file it was
  # explicitly meant to send, which is the failure mode that teaches people to
  # pass --force and stop reading the output.
  base=${found##*/}
  case "$base" in
    .env | .env.*)
      leaked+=("$found")
      ;;
  esac
done < <(git ls-files -- "${present[@]}" || true)

if [ ${#leaked[@]} -gt 0 ]; then
  printf '下列含真实值的文件会被上传：\n' >&2
  printf '  %s\n' "${leaked[@]}" >&2
  die "已阻止。凭据请在服务器上手工创建，不要经过传输。"
fi

# --- 3. 打包 -----------------------------------------------------------------
# 用 git archive 而不是 tar 目录树：它只打包**已提交**的内容，
# 因此不会把本地未提交的临时文件、编辑器备份、或某个忘了删的 .env 捎上去。
# 这是比"列一份排除清单"更强的不变量：排除清单会漏，已提交状态不会。
printf '打包（只含已提交内容）...\n'
tmp=$(mktemp -t voting-upload.XXXXXX.tar)
trap 'rm -f "$tmp"' EXIT

# git archive 的路径参数相对仓库根，正好等于 present[] 里的相对路径。
git archive --format=tar --output="$tmp" HEAD -- "${present[@]}"

bytes=$(wc -c <"$tmp" | tr -d ' ')
printf '包大小: %s 字节\n' "$bytes"

if [ "$dry_run" -eq 1 ]; then
  printf '\n--dry-run：实际会传的内容如下（未传输）\n\n'
  tar -tf "$tmp"
  printf '\n目标会是: %s:%s/\n' "$target" "$dest"
  printf '端口:     %s\n' "$port"
  printf '\n真正的命令会是:\n'
  printf '  ssh -p %s %s "mkdir -p %s"\n' "$port" "$target" "$dest"
  printf '  scp -P %s %s %s:/tmp/voting-upload.tar\n' "$port" "$tmp" "$target"
  printf '\n（--dry-run 不会执行上面两条）\n'
  exit 0
fi

# --- 4. 传输 -----------------------------------------------------------------
# 先建目录，再传包。这两条**不在目标机上执行任意命令**：mkdir 是脚本作者写死的，
# 不接受任何来自上传内容的参数。包本身不会被解压——解压是你在服务器上的动作。
printf '\n建立远端目录 %s ...\n' "$dest"
ssh -p "$port" -o BatchMode=yes "$target" "mkdir -p '$dest'"

printf '上传中...\n'
scp -P "$port" -o BatchMode=yes "$tmp" "$target:/tmp/voting-upload.tar"

printf '\n完成。包已传到 %s:/tmp/voting-upload.tar\n' "$target"

# --- 5. 告诉人下一步 --------------------------------------------------------
# 刻意把这部分做成"给人看的提示"而不是"自动执行"。脚本到此为止。
#
# 这段文字里的每一步都在服务器上被验证过，包括失败的那两种做法：
#   * 原来写的 `docker compose ... build` 在这台主机上什么也不建——包里没有
#     web/ 源码，compose 文件里也没有 build: 段，它只打印 No services to build；
#   * 原来写的 `cp .env.example .env` 会缺 WEB_IMAGE 与 MYSQL_*，生产 compose
#     因此拒绝渲染（${WEB_IMAGE:?}），照做的人看到的是一个看不懂的报错。
# 提示文字是这套交付里唯一会被人照抄的东西，所以它必须等于真的能跑通的那条路。
#
# 注意：这里是未加引号的 heredoc，$dest 会被展开。正文里不要出现反引号、
# $( ) 或 ${ }，否则会被 shell 执行或报 bad substitution。
cat <<EOF

下一步（请自己登录服务器执行）：

  1. 解开包（不会覆盖已有文件，-k 让你能看到冲突而不是被静默覆盖）：

       cd $dest
       tar -xkvf /tmp/voting-upload.tar
       rm /tmp/voting-upload.tar

  2. 创建生产 .env（**这个文件不走上传**，里面有真实口令）：

       cd $dest
       cp deploy-env/server.env .env        # 不是 .env.example
       chmod 600 .env
       # 把 .env 里每个「你定」换成真值。RPC_URL / CHAIN_ID / WEB_IMAGE 必须填：
       # 生产 compose 把前两个声明成必填变量，缺一个就拒绝渲染整份配置。
       # .env.example 只是仓库内的最小示例，没有 WEB_IMAGE 与 MYSQL_*，照它填起不来。

  3. 镜像：**不要在服务器上构建**。

       这个包里没有 web/ 源码，两个 compose 文件里也没有 build: 段，所以
       docker compose build 什么都不建（只会打印 No services to build）。
       镜像只有两个来源：

         a) CI 推送：release.yml 成功后打的是 sha-<12位> 这种不可变标签；
         b) 在另一台有完整检出的机器上构建并推送：

              docker build -f web/Dockerfile -t <仓库>/voting-web:<tag> .
              docker push <仓库>/voting-web:<tag>

  4. 第一次起栈（顺序不能反）：

       nginx 的配置用精确路径 include upstream.conf，该文件不存在时 nginx 直接
       拒绝启动，而它由渲染脚本产生。所以先渲染，再起栈：

       cd $dest
       ./ops/nginx/render-upstream.sh blue
       WEB_IMAGE=<仓库>/voting-web WEB_IMAGE_TAG=<tag> \\
         docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

  5. 之后每次发布都走发布脚本（状态文件与上游文件都由它在服务器上写，
     不要再手动 up -d 绕过它）：

       cd $dest
       PUBLIC_HEALTH_URL=https://<域名>/api/health \\
         WEB_IMAGE=<仓库>/voting-web ./ops/deploy/deploy.sh <tag>

       PUBLIC_HEALTH_URL 必须给：默认探的是 https://localhost/api/health，而你
       证书上的名字是域名，curl 过不了校验，部署会在切完流量之后报观察窗失败。
       它只从 shell 环境读，不读 .env。

  6. 看状态：

       docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
       curl -sS localhost/api/health        # 期望 200；索引不可用时状态为 degraded

注意：**不要**使用 docker-compose.override.yml，它只用于本地开发。
生产命令必须显式写出 -f docker-compose.yml -f docker-compose.prod.yml 两个文件。
要用服务器上已有的 MySQL（不起 mysql 容器），再加上
-f docker-compose.external-db.yml，并按该文件头部列出的三条前提先把 MySQL 配好。

EOF
