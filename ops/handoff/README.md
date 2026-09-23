# 两个交接脚本

各自只需要一份输入，做一件事，做完就停。

| 脚本                                 | 你需要提供             | 它做什么                           |
| ------------------------------------ | ---------------------- | ---------------------------------- |
| `push-to-github.bat` / `.sh`         | GitHub 仓库的 SSH 地址 | 把本仓库推上去                     |
| `upload-to-server.bat` / `.sh`       | 服务器 IP + SSH 用户名 | 把部署所需文件传上去（不远程执行） |

`push-to-github.cmd` / `upload-to-server.cmd` 仍然存在，是给**不在这台机器上的
Windows 用户**用的兼容入口；本机请直接用 `.bat`。

## 在 Windows 上：用 `.bat`

```powershell
ops\handoff\push-to-github.bat git@github.com:你的用户名/decentralized-voting-dapp.git
ops\handoff\upload-to-server.bat deploy@你的服务器IP --dry-run
ops\handoff\upload-to-server.bat deploy@你的服务器IP
```

`.bat` 也可以**双击运行**（会自动暂停，否则窗口一闪就没了）。不带参数双击会打印用法。

### 为什么 `.bat` 是自包含的，而 `.cmd` 只是转发壳

早期版本只有 `.cmd`，它做的事是：找到 Git for Windows 的 bash → 切到仓库根 →
把参数转交给 `.sh`。这样做的理由是 `.sh` 能被 CI 的 shellcheck 和单元测试覆盖。

但代价比收益大：**全部复杂度都压在一个跨语言边界上，而边界两边的差异没有任何
测试覆盖**。实际踩到的每一个坑都不是逻辑问题，而是 cmd 与 bash 之间的语言边界问题：

| 踩到的坑                                   | 根源                                   |
| ------------------------------------------ | -------------------------------------- |
| 中文 `.cmd` 在 cp936 下崩成 exit 255       | cmd.exe 用 OEM 代码页解码              |
| BOM 让脚本**静默地什么都不输出**、退出码 0 | cmd.exe 的 BOM 处理                    |
| LF 行尾让注释被当命令执行                  | cmd.exe 的行尾处理                     |
| `pause` 判别靠猜 `cmdcmdline` 的拼写       | 反向猜测另一个程序的字符串约定         |
| `%~dp0` 在 `popd` 后指向错误目录           | cmd 的变量在**解析时**展开而非运行时   |

`push-to-github.bat` 和 `upload-to-server.bat` 是**独立实现**，直接调用
`git` / `tar` / `ssh` / `scp`，完全不经过 bash。这就消掉了整类问题——不再有边界。

`.sh` 保留给 Linux / macOS / CI，而且 **CI 那份门禁一条都没少**。
两个实现会不会漂移，由 `selftest.py` 断言：同一组参数下 `.bat` 与 `.sh`
的**退出码必须相同**（当前 18 项这样的比对）。

### `.bat` 与 `.cmd` 的编码约束不同

`.cmd` 必须是**纯 ASCII**（原因见下节）。`.bat` 不是——它按设计就带中文输出，
安全性来自**在任何中文行被解析之前先 `chcp 65001`**，并以 UTF-8 无 BOM + CRLF 保存。

`selftest.py` 对 `.bat` 断言的是这三条，而不是"ASCII"：

1. 无 BOM；
2. 全部 CRLF；
3. **`chcp 65001` 出现在第一个非 ASCII 字符之前**（这才是 ASCII 规则真正想保护的不变量）。

### 关于 `.cmd`：它是纯 ASCII 的转发壳

`.cmd` 保留着，但本机不需要用。它的约束比 `.bat` 严格得多，因为 cmd.exe 用
OEM 代码页（本机 936）解码 `.cmd`，任何非 ASCII 字节都会被误读并**当命令执行**。
详见下节——那是本阶段最贵的一次事故。

### 为什么不能直接 `bash xxx.sh`

这台机器上 PATH 里的 `bash` 是 **WSL 的入口**（`C:\Windows\system32\bash.exe`），
而 WSL 因为 `VirtualMachinePlatform` 未启用是坏的。实测：

```
bash -c 'echo hello'   → WSL2 内核错误，退出码 -1
Git 的 bash            → hello，退出码 0
```

直接打 `bash ops/handoff/push-to-github.sh` 会报一个 WSL 内核错误，与本项目毫无关系，
很容易让人去排查一个不存在的问题。

用 `.bat` 就完全绕开了这件事：它**不需要 bash**。只有 `.cmd` 才需要去找
Git for Windows 的 bash（`C:\Program Files\Git\bin\bash.exe` 等几处），并主动跳过
System32 那个。

### `.cmd` 文件必须是**纯 ASCII**、无 BOM、CRLF

这不是风格问题，是 cmd.exe 的陷阱，全部实际踩到过：

| 变体                   | 结果                                             |
| ---------------------- | ------------------------------------------------ |
| UTF-8 中文 + **LF**    | 解析失败，中文行被**当命令执行**                 |
| UTF-8 **中文** + CRLF  | 控制台 cp936 下**同样崩**，退出码 255（见下）    |
| UTF-8 + **BOM** + CRLF | **什么都不输出**，无报错，退出码 0               |
| ASCII + CRLF           | 正常                                             |

**"UTF-8 + CRLF" 曾经被当作正确答案写在这里，那是错的。** 已提交的那版启动器
就是 UTF-8 + CRLF、REM 注释和 `echo` 里带中文；在 cp936 控制台下实测：

```
'F' 不是内部或外部命令，也不是可运行的程序
'ps\handoff\' 不是内部或外部命令……
```

每一行都被按 OEM 代码页解码，行尾字节被当成命令执行，**整次运行在打印任何
可用输出之前就以 255 退出**。实测记录留存在 `docs/codepage-probe-results.txt`。

关键教训在测试上：当时的自测断言是"能按 UTF-8 解码"，而那个坏文件**完全能通过
这条断言**——测试是绿的，启动器是坏的。现在改为断言**纯 ASCII**，因为 ASCII 是
唯一在 cp936 和 cp65001 下解析结果相同的编码。这也是所有中文输出都放在 `.sh`
里的原因：Git bash 打印的字节原样穿过 cmd，两种代码页下都实测正常。

`selftest.py` 现在盯三点（BOM / CRLF / 纯 ASCII），并在 Windows 上比对启动器
与脚本的退出码是否一致。

### 双击才暂停，且不再靠猜命令行

双击的窗口会在脚本结束时立刻关闭，所以那种情况要 `pause`；但程序化调用
（PowerShell、cmd、CI）**绝不能**暂停，否则会挂住自动化。

旧实现靠匹配 `cmdcmdline` 里有没有 `/c "`——那是在猜 Explorer 拼出来的字符串，
而且只用作者**手写的模拟**验证过。实测真实双击的命令行是：

```
cmd.exe /c ""D:\桌面\_real_dblclick_test.cmd" "
```

末尾那个空格、以及路径含中文时的加引号方式，都和模拟的不一样。现在改为问
Windows 一件确定的事：**这个 cmd.exe 的父进程是不是 explorer.exe**（真实双击
实测确认是）。这与命令行怎么拼写无关。

探测代码在 `_pause-if-doubleclicked.cmd` + `_parent-name.ps1`。两个实现细节是
实测撞出来的，都记在文件注释里：

- `-File` **不能**接含中文的绝对路径：PowerShell 会先把它弄成 `D:\??\????\...`
  再报 `Illegal characters in path`，而 cmd 侧看不到任何错误——探测静默失效，
  表现和"不是双击"完全一样。改成先 `pushd` 再用相对文件名。
- PowerShell 命令内联进 `for /f` 的反引号里，括号和引号会被 cmd 提前解析，
  循环什么都拿不到。拆成独立 `.ps1` 文件后没有转义可错。

探测失败时的策略是**不暂停**：少一次暂停只是不好看，多一次暂停会挂死自动化。

## 在 Linux / macOS / Git Bash 里：用 `.sh`

```bash
ops/handoff/push-to-github.sh git@github.com:你的用户名/decentralized-voting-dapp.git
ops/handoff/upload-to-server.sh deploy@你的服务器IP --dry-run
```

`.sh` 是 CI 上跑的、shellcheck 检查的那一份。**本机不要用**——PATH 里的 `bash`
是坏掉的 WSL 入口（见上）。

`.bat` 和 `.sh` 是两份独立实现，规则必须一致。**一致性不靠自觉，靠断言**：
`selftest.py` 对同一组参数比对两者的退出码。这不是形式主义——初版 `.cmd` 复制了
一份用法文本，结果无参数时返回 0 而 `.sh` 返回 2，同一个错误有两个答案。

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
python ops/handoff/selftest.py      # 79 项
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

### 自测**覆盖不到**什么

必须写清楚，否则这些绿勾会给出错误的安全感：

- **真实传输从未被端到端跑过。** 所有用例都止步于 `--dry-run`，也就是只验证到
  "要传什么"。真正执行 `ssh` / `scp` 的那几行（`upload-to-server.sh` 第 203 行起、
  `upload-to-server.bat` 的"传输"一段）**没有任何测试覆盖**，也从没有一次真实的
  服务器上传发生过。实测到的只有：命令的参数形式在本机解析正确、连不通时返回 255。
  **没有验证过任何一次成功的上传。**
- **`.bat` 与 `.sh` 的一致性只覆盖参数校验。** 两者都实现同一套规则，但比对只做到
  退出码层面、且只用那些"不碰网络也不写文件"的参数组合。真正会分叉的地方
  （`git ls-files` 的路径过滤、`git archive` 的打包口径）是靠各自单独测的，
  没有交叉验证。
- **双击检测靠手工验证。** 从测试进程里造不出真正的双击，所以
  `selftest.py` 只覆盖 `PAUSE_ALWAYS` 强制路径和"程序化调用不暂停"。
  父进程探测本身是用真实双击手工测的（见上文）。
- **启动器里的 PowerShell 探测有约 0.5 秒开销**，每次调用启动器都会付。
  `.bat` 也一样，因为它们共用同一个探测。
