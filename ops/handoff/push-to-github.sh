#!/usr/bin/env bash
#
# 把本仓库推送到 GitHub。只做这一件事。
#
#   usage: ops/handoff/push-to-github.sh <git@github.com:user/repo.git> [branch]
#
# 它**不会**创建仓库、不会配置 Actions 变量、不会改 .git/config 之外的东西。
# 仓库需要你先在 GitHub 上建好（空的即可，不要勾选 README/gitignore）。
#
# 为什么单独写一个脚本，而不是让你记几条 git 命令
# -------------------------------------------------
#
# 推一个含真实凭据历史的仓库，有几个具体的坑，每一个都会静默地造成损害：
#
#   1. **工作区脏着推上去。** `git push` 只推已提交的内容，工作区里未提交的文件
#      不会被推走——这通常没事，但如果那个未提交文件是本该提交的配置，你会以为
#      服务器上有了，实际没有。
#
#   2. **密钥被推上去。** contracts/.env 与 web/.env 含明文私钥与口令。它们被
#      .gitignore 挡住，但 .gitignore **对已经被跟踪的文件无效**，而且改错目录的
#      忽略规则同样无效。所以推之前必须实际验证，而不是假设它生效。
#
#   3. **推错分支。** 直接 `git push origin main` 而 main 不是当前分支，
#      推上去的是你上次提交的旧状态。
#
#   4. **强推覆盖别人的提交。** 加 --force 是一个习惯动作，而它在这个仓库里
#      会把并发的另一条工作线抹掉。本脚本永不使用 --force。
#
# 所以这个脚本先检查，再推。任何一项检查不过就停下，并说明原因。
#
# 退出码：0 成功；1 检查失败或推送失败；2 用法错误。

set -euo pipefail

readonly EXIT_USAGE=2

die() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
用法: ops/handoff/push-to-github.sh <远端地址> [分支]

  远端地址   形如 git@github.com:用户名/仓库名.git
  分支       默认 main

示例:
  ops/handoff/push-to-github.sh git@github.com:zhangsan/decentralized-voting-dapp.git
  ops/handoff/push-to-github.sh git@github.com:zhangsan/decentralized-voting-dapp.git main
EOF
  exit "$EXIT_USAGE"
}

[ $# -ge 1 ] || usage
[ $# -le 2 ] || usage

remote_url=$1
branch=${2:-main}

# --- 0. 必须在仓库根目录运行 ------------------------------------------------
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  die "当前目录不是一个 git 仓库。请在仓库内运行本脚本。"
cd "$repo_root"

printf '仓库:   %s\n' "$repo_root"
printf '远端:   %s\n' "$remote_url"
printf '分支:   %s\n' "$branch"
printf '\n'

# --- 1. 远端地址看起来对吗 --------------------------------------------------
# 只接受 SSH 形式。HTTPS 形式在这里被拒绝，不是因为 HTTPS 不行，而是因为
# 用户明确要求用 SSH，而且 HTTPS 会触发交互式凭据提示——在一个自动化脚本里
# 那表现为"卡住"，而不是"报错"。
case "$remote_url" in
  git@*:* | ssh://*)
    ;;
  https://*)
    die "这是 HTTPS 地址。请改用 SSH 形式：git@github.com:用户名/仓库名.git"
    ;;
  *)
    die "无法识别的远端地址（应为 git@github.com:用户名/仓库名.git）：$remote_url"
    ;;
esac

# --- 2. 分支存在吗 ----------------------------------------------------------
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null ||
  die "本地没有分支 $branch。当前分支是 $(git rev-parse --abbrev-ref HEAD)。"

# 不推一个"当前检出的分支以外"的分支。这是上面第 3 个坑：人以为推的是眼前这份
# 代码，实际推的是另一个分支上更旧的提交。
current=$(git rev-parse --abbrev-ref HEAD)
if [ "$current" != "$branch" ]; then
  die "当前在分支 $current 上，但你要求推 $branch。请先 git switch $branch，或把分支参数写成 $current。"
fi

# --- 3. 工作区必须干净 ------------------------------------------------------
# 允许未跟踪文件（例如备份目录），但已跟踪文件的改动会让人误判"推上去的就是
# 服务器上跑的"。这里只拦已跟踪文件的改动。
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf '已跟踪文件里有未提交的改动：\n' >&2
  git status --short >&2
  die "请先提交或 stash 改动，再推送。"
fi

# --- 4. 凭据文件绝不入库 ----------------------------------------------------
# 这是整个脚本最重要的一段。检查的是 **git 实际会推的内容**（已跟踪文件），
# 而不是文件系统上的文件——.gitignore 让文件存在但不被跟踪，正是我们想要的。
leaked=0
while IFS= read -r f; do
  case "$f" in
    .env | */.env | .env.* | */.env.*)
      # .env.example 是模板，应该入库；只有真实 .env 是问题。
      case "$f" in
        *.example) continue ;;
      esac
      printf '  被跟踪的凭据文件: %s\n' "$f" >&2
      leaked=1
      ;;
  esac
done < <(git ls-files)

[ "$leaked" -eq 0 ] || die "有 .env 文件被 git 跟踪，推送会把真实凭据发到 GitHub。请先 git rm --cached 它们。"

# 再检查内容：即使文件名正常，值也可能被粘进别的文件。
# 这里只找**看起来像真实值**的模式，占位符与变量名不算。
if git grep -qE '^SEPOLIA_PRIVATE_KEY=0x[0-9a-fA-F]{64}' -- . 2>/dev/null; then
  printf '  命中：某个被跟踪文件里有 SEPOLIA_PRIVATE_KEY=0x<64位十六进制>\n' >&2
  die "被跟踪文件里有明文私钥。"
fi

printf '检查通过。\n\n'

# --- 5. 配置远端并推送 ------------------------------------------------------
# 只在 remote 不存在时添加；存在就改地址（幂等）。
if git remote get-url origin >/dev/null 2>&1; then
  existing=$(git remote get-url origin)
  if [ "$existing" != "$remote_url" ]; then
    printf 'origin 原本是 %s，改为 %s\n' "$existing" "$remote_url"
    git remote set-url origin "$remote_url"
  fi
else
  git remote add origin "$remote_url"
fi

printf '推送中（不使用 --force）...\n'
# -u 让分支跟踪远端，之后直接 git push 即可。
git push -u origin "$branch"

printf '\n完成。\n'
printf '接下来在 GitHub 仓库的 Settings → Secrets and variables → Actions 里填变量与密钥，\n'
printf '清单见 deploy-env/github-actions.txt。\n'
