# 两个交接脚本

各自只需要一份输入，做一件事，做完就停。

| 脚本                           | 你需要提供             | 它做什么                           |
| ------------------------------ | ---------------------- | ---------------------------------- |
| `push-to-github.cmd` / `.sh`   | GitHub 仓库的 SSH 地址 | 把本仓库推上去                     |
| `upload-to-server.cmd` / `.sh` | 服务器 IP + SSH 用户名 | 把部署所需文件传上去（不远程执行） |

## 在 Windows 上：用 `.cmd`

```powershell
ops\handoff\push-to-github.cmd git@github.com:你的用户名/decentralized-voting-dapp.git
ops\handoff\upload-to-server.cmd deploy@你的服务器IP --dry-run
ops\handoff\upload-to-server.cmd deploy@你的服务器IP
```

`.cmd` 也可以**双击运行**（会自动暂停，否则窗口一闪就没了）。不带参数双击会打印用法。

### 为什么必须用 `.cmd` 而不是直接 `bash xxx.sh`

这台机器上 PATH 里的 `bash` 是 **WSL 的入口**（`C:\Windows\system32\bash.exe`），
而 WSL 因为 `VirtualMachinePlatform` 未启用是坏的。实测：

```
bash -c 'echo hello'   → WSL2 内核错误，退出码 -1
Git 的 bash            → hello，退出码 0
```

直接打 `bash ops/handoff/push-to-github.sh` 会报一个 WSL 内核错误，与本项目毫无关系，
很容易让人去排查一个不存在的问题。`.cmd` 启动器因此**显式定位 Git for Windows 的
bash**（`C:\Program Files\Git\bin\bash.exe` 等几处），并主动跳过 System32 那个。

需要装 [Git for Windows](https://git-scm.com/download/win)。找不到时启动器会直接说明。

### `.cmd` 文件必须是 UTF-8 无 BOM + CRLF

这不是风格问题，是 cmd.exe 的两个隐形陷阱，两个都实际踩到了：

| 变体                   | 结果                               |
| ---------------------- | ---------------------------------- |
| UTF-8 + **LF**         | 解析失败，中文行被**当命令执行**   |
| UTF-8 + CRLF           | 正常                               |
| UTF-8 + **BOM** + CRLF | **什么都不输出**，无报错，退出码 0 |
| GBK + CRLF             | 乱码                               |

两者在编辑器和 diff 里都看不出来。`ops/handoff/selftest.py` 有断言盯着这两点，
并在 Windows 上比对启动器与脚本的退出码是否一致。

## 在 Linux / macOS / Git Bash 里：用 `.sh`

```bash
ops/handoff/push-to-github.sh git@github.com:你的用户名/decentralized-voting-dapp.git
ops/handoff/upload-to-server.sh deploy@你的服务器IP --dry-run
```

`.sh` 是唯一实现：CI 上跑的、shellcheck 检查的、有单元测试覆盖的都是它。
`.cmd` 只做三件事——找到 Git 的 bash、切到仓库根、把参数原样转交。
**刻意不在 `.cmd` 里重写一份逻辑**：初版复制了一份用法文本，结果无参数时
`.cmd` 返回 0 而 `.sh` 返回 2，同一个错误的两种答案。

传输用 `scp` + `tar`（本机没有 `rsync`）。`ssh` / `scp` / `ssh-keygen` /
`ssh-keyscan` 均已确认可用。

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
