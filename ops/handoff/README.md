# 两个交接脚本

各自只需要一份输入，做一件事，做完就停。

| 脚本                  | 你需要提供             | 它做什么                           |
| --------------------- | ---------------------- | ---------------------------------- |
| `push-to-github.sh`   | GitHub 仓库的 SSH 地址 | 把本仓库推上去                     |
| `upload-to-server.sh` | 服务器 IP + SSH 用户名 | 把部署所需文件传上去（不远程执行） |

两个都不需要你先装什么。本机 `ssh` / `scp` / `ssh-keygen` / `ssh-keyscan` 已确认可用
（`rsync` 没有，所以传输用 `scp` + `tar`）。

---

## 脚本 B：推送到 GitHub

先在 GitHub 上建一个**空仓库**（不要勾 README、不要勾 .gitignore），然后：

```bash
ops/handoff/push-to-github.sh git@github.com:你的用户名/decentralized-voting-dapp.git
```

推完去仓库的 **Settings → Secrets and variables → Actions** 填变量与密钥，
清单位于 `deploy-env/github-actions.txt`。

### 它会拦下什么

推一个含真实凭据历史的仓库，有四个坑，每个都会**静默**造成损害：

1. **已跟踪的 `.env`。** `.gitignore` 只对未跟踪文件有效。一旦有人
   `git add -f .env`，那个文件就永久进入跟踪状态，之后每次推送都会带上它。
   脚本直接检查 `git ls-files` 里有没有 `.env`，有就停。
2. **私钥被粘进别的文件。** 文件名正常不代表内容安全。脚本另做一次内容扫描，
   找 `SEPOLIA_PRIVATE_KEY=0x` + 64 位十六进制。
3. **推错分支。** `git push origin main` 而当前不在 main 上时，推走的是另一个分支
   上的旧提交——你以为是眼前这份代码。
4. **强推覆盖别人的提交。** 脚本**永不**使用 `--force`。这一条有自测盯着：
   它检查真正的 `git push` 命令行里没有 `--force`。

工作区有未提交改动时也会停（只查已跟踪文件；未跟踪的临时文件不影响，
因为它们本来就不会被推走）。

---

## 脚本 A：上传到服务器

```bash
ops/handoff/upload-to-server.sh deploy@你的服务器IP
ops/handoff/upload-to-server.sh deploy@你的服务器IP --port 2222 --dest /srv/voting
ops/handoff/upload-to-server.sh deploy@你的服务器IP --dry-run    # 先看会传什么
```

### 它只上传，不在服务器上执行命令

这是刻意的分工。一个"上传并部署"的脚本要 ssh 进服务器跑命令，那意味着：
脚本以你的身份在服务器上执行任意操作；每一步都依赖远端环境（装了 docker 吗？
有 envsubst 吗？路径对吗？）而这些在本机无从验证；而且你无法在
"文件传上去了"和"服务被启动了"之间停下来看一眼。

所以脚本只做两件事：`mkdir -p <目标目录>`（路径由你传参，不接受任何来自
上传内容的输入），然后 `scp` 一个包。**解压和启动由你登录后自己做**——
脚本结束时会把具体命令打印出来。

### 它传什么

- `docker-compose.yml`、`docker-compose.prod.yml`
- `ops/`（部署脚本、nginx、监控配置、运维手册）
- `deploy-env/server.env`（`.env` 模板）
- `.env.example`

**不传**：`web/`、`contracts/`、`node_modules/`、以及任何 `.env`。
服务器上服务跑在容器里，应用代码由镜像自带。

### 打包用的是 `git archive`，不是目录树

`git archive HEAD` 只打包**已提交**的内容。这比列一份排除清单更强：
排除清单会漏，而已提交状态不会。本地未提交的临时文件、编辑器备份、
某个忘了删的 `.env`，都不会被捎上去。

### 它拦下什么

含真实值的 `.env` 一旦出现在**将要打包的路径**上，脚本就停。
凭据必须由你在服务器上就地创建：走 scp 的话它会经过本机临时文件、SSH 会话、
以及远端磁盘上的一个中间位置；手工创建只有一次落盘。

这里有两次自测抓出来的真实错误，值得记下来：

- **守卫的匹配范围错了会误报。** 最初用 `\.env$` 匹配路径，结果把
  `deploy-env/server.env`（一个**应该**上传的模板）也拦了。
  一个会误报的守卫比没有守卫更糟，因为它训练人忽略它。
  现在只匹配文件名。
- **检查口径必须与打包口径一致。** 最初用 `find` 扫磁盘，而打包用
  `git archive`（只看已提交）。两者不一致时会拦下**根本不会被传走**的文件。
  现在检查统一走 `git ls-files`。

---

## 自测

```bash
python ops/handoff/selftest.py      # 27 项
```

在临时目录里用**真 git** 造仓库（不是 mock），然后故意制造危险状态，
断言脚本拒绝执行。用真 git 是因为脚本的检查本身就建立在 git 语义上
（`git ls-files` 看得见什么、`git archive` 打包什么），mock 掉 git
等于把被测逻辑一起 mock 掉。

已在真实仓库上另做过一次双向验证：正常路径放行（**64 项 = 43 个文件 + 21 个目录，
包大小 280 KB**，含 `deploy-env/server.env`、不含 `github-actions.txt`、无任何 `.env`），
把 `.env` 放到 payload 路径上则被拦下，且验证过程未改动仓库。

这个自测已接入 CI 的 `deploy-scripts` job。写好的断言如果没人跑，
就只是文档而不是门禁——这一点本阶段已经栽过四次。
