#!/usr/bin/env python3
"""ops/handoff/ 两个交接脚本的自测。

两个脚本都做"传输"这一类不可逆动作，所以这里的重点不是"正常路径能跑通"，
而是**每个安全断言都必须能失败**。一个从不在该拦的时候拦下来的守卫，
和没有守卫是一样的，只是更让人放心。

测法：在临时目录里造一个假的 git 仓库（真的 git，不是 mock），把脚本指向它，
然后故意制造各种危险状态，断言脚本拒绝执行。

用真 git 而不是 mock，是因为脚本的检查本身就建立在 git 的语义上
（`git ls-files` 看得见什么、`git archive` 打包什么）。mock 掉 git 就等于
把被测逻辑也一起 mock 掉了。

用法：python ops/handoff/selftest.py
退出码 0 = 全部通过。
"""

from __future__ import annotations

import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
BASH = r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else "bash"

PUSH = "ops/handoff/push-to-github.sh"
UPLOAD = "ops/handoff/upload-to-server.sh"

# git 需要一个身份才能提交。设成局部的，不碰用户的全局配置。
GIT_ENV = {
    "GIT_AUTHOR_NAME": "selftest",
    "GIT_AUTHOR_EMAIL": "selftest@example.invalid",
    "GIT_COMMITTER_NAME": "selftest",
    "GIT_COMMITTER_EMAIL": "selftest@example.invalid",
}


def sh(args, cwd, check=True):
    env = dict(os.environ)
    env.update(GIT_ENV)
    r = subprocess.run(
        args, cwd=cwd, capture_output=True, encoding="utf-8", errors="replace", env=env
    )
    if check and r.returncode != 0:
        raise RuntimeError(f"{args} failed ({r.returncode}): {r.stdout}{r.stderr}")
    return r


def bash(script, args, cwd):
    """Run a repository script inside a sandbox checkout."""
    path = pathlib.Path(cwd) / script
    r = subprocess.run(
        [BASH, str(path), *args],
        cwd=cwd,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def make_repo(root: pathlib.Path) -> pathlib.Path:
    """A minimal, real git repository that looks like this one."""
    work = root / "work"
    work.mkdir(parents=True)
    sh(["git", "init", "-q", "-b", "main"], work)
    sh(["git", "config", "user.email", "selftest@example.invalid"], work)
    sh(["git", "config", "user.name", "selftest"], work)

    # The payload the upload script expects.
    (work / "ops" / "deploy").mkdir(parents=True)
    (work / "ops" / "deploy" / "deploy.sh").write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
    (work / ".env.example").write_text("RPC_URL=\n", encoding="utf-8")
    (work / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    (work / "docker-compose.prod.yml").write_text("services: {}\n", encoding="utf-8")
    (work / "deploy-env").mkdir()
    # git does not track empty directories, so `git archive` would not find
    # `deploy-env` at all. This mirrors the real repository, where the directory
    # holds server.env and github-actions.txt.
    (work / "deploy-env" / "server.env").write_text("RPC_URL=\n", encoding="utf-8")
    # This one is a checklist for a human filling in GitHub's web form. It is in
    # the same directory but must NOT be uploaded; a test below asserts that.
    (work / "deploy-env" / "github-actions.txt").write_text("VARS\n", encoding="utf-8")

    # The scripts under test.
    dest = work / "ops" / "handoff"
    dest.mkdir()
    for name in ("push-to-github.sh", "upload-to-server.sh"):
        shutil.copy2(REPO / "ops" / "handoff" / name, dest / name)

    # Mirror the real repository's rules exactly. An earlier version of this
    # used a bare `*.env`, which also ignored `deploy-env/server.env` -- a file
    # that SHOULD be tracked. Getting the fixture's own rules wrong made four
    # assertions fail for a reason that had nothing to do with the script.
    (work / ".gitignore").write_text(".env\n.env.*\n!.env.example\n", encoding="utf-8")
    sh(["git", "add", "-A"], work)
    sh(["git", "commit", "-q", "-m", "init"], work)
    return work


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def ok(self, msg: str) -> None:
        self.passed += 1
        print(f"  ok   {msg}")

    def bad(self, msg: str, detail: str = "") -> None:
        self.failed += 1
        print(f"  FAIL {msg}")
        if detail:
            for line in detail.strip().splitlines()[:6]:
                print(f"         {line}")

    def check(self, cond: bool, msg: str, detail: str = "") -> None:
        self.ok(msg) if cond else self.bad(msg, detail)


def main() -> int:
    r = Results()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)

        # ---------------------------------------------------------------- push
        print("push-to-github.sh")

        work = make_repo(tmp_path / "a")

        code, out = bash(PUSH, [], work)
        r.check(code == 2, "no arguments exits 2 (usage)", out)

        code, out = bash(PUSH, ["https://github.com/x/y.git"], work)
        r.check(
            code == 1 and "HTTPS" in out,
            "an HTTPS remote is refused with the SSH form suggested",
            out,
        )

        code, out = bash(PUSH, ["not-a-remote"], work)
        r.check(code == 1 and "无法识别" in out, "a malformed remote is refused", out)

        code, out = bash(PUSH, ["git@github.com:x/y.git", "nope"], work)
        r.check(code == 1 and "nope" in out, "a branch that does not exist is refused", out)

        # --- the one that matters: a tracked credential file must stop the push.
        (work / ".env").write_text("SEPOLIA_PRIVATE_KEY=0x" + "a" * 64 + "\n", encoding="utf-8")
        sh(["git", "add", "-f", ".env"], work)
        sh(["git", "commit", "-q", "-m", "oops"], work)
        code, out = bash(PUSH, ["git@github.com:x/y.git"], work)
        r.check(
            code == 1 and "凭据" in out,
            "a TRACKED .env stops the push (--force-add defeats .gitignore, so this is the real case)",
            out,
        )
        r.check(".env" in out, "  ...and the offending path is named", out)

        # Remove it again; the private key check should still fire on content.
        sh(["git", "rm", "-q", "--cached", ".env"], work)
        (work / "leak.txt").write_text(
            "SEPOLIA_PRIVATE_KEY=0x" + "b" * 64 + "\n", encoding="utf-8"
        )
        sh(["git", "add", "leak.txt"], work)
        sh(["git", "commit", "-q", "-m", "leak"], work)
        code, out = bash(PUSH, ["git@github.com:x/y.git"], work)
        r.check(
            code == 1 and "私钥" in out,
            "a private key pasted into an innocently-named file also stops the push",
            out,
        )

        # --- dirty tracked files
        work2 = make_repo(tmp_path / "b")
        (work2 / "docker-compose.yml").write_text("services: {changed: true}\n", encoding="utf-8")
        code, out = bash(PUSH, ["git@github.com:x/y.git"], work2)
        r.check(
            code == 1 and "未提交" in out,
            "uncommitted changes to tracked files stop the push",
            out,
        )

        # --- untracked files are allowed (they are not what gets pushed)
        (work2 / "scratch.txt").write_text("local only\n", encoding="utf-8")
        sh(["git", "checkout", "--", "docker-compose.yml"], work2)
        code, out = bash(PUSH, ["git@github.com:x/y.git"], work2)
        # It will now get past its checks and fail at the network step, which is
        # the point: the checks are what we are testing, not GitHub.
        r.check(
            "未提交" not in out,
            "an untracked scratch file does NOT block (it would not be pushed anyway)",
            out,
        )

        # --- never force
        # Check the actual command lines, not the prose. The script legitimately
        # *mentions* --force in a comment and in a printf telling the reader it
        # is not used, so a naive "does the word appear" test fails on correct
        # code. Only `git push` invocations matter.
        script = (REPO / PUSH).read_text(encoding="utf-8")
        push_lines = [
            line
            for line in script.splitlines()
            if line.strip().startswith("git push")
        ]
        r.check(
            bool(push_lines),
            "the script contains a git push invocation (the check below is not vacuous)",
        )
        r.check(
            all("--force" not in line for line in push_lines),
            "the push command never passes --force",
            "\n".join(push_lines),
        )

        # -------------------------------------------------------------- upload
        print("\nupload-to-server.sh")

        work3 = make_repo(tmp_path / "c")

        code, out = bash(UPLOAD, [], work3)
        r.check(code == 2, "no arguments exits 2 (usage)", out)

        code, out = bash(UPLOAD, ["nohost"], work3)
        r.check(code == 1 and "user@host" in out, "a target without user@ is refused", out)

        code, out = bash(UPLOAD, ["deploy@h", "--port", "abc"], work3)
        r.check(code == 1 and "数字" in out, "a non-numeric port is refused", out)

        code, out = bash(UPLOAD, ["deploy@h", "--dest", "relative/path"], work3)
        r.check(code == 1 and "绝对路径" in out, "a relative --dest is refused", out)

        code, out = bash(UPLOAD, ["deploy@h", "--bogus"], work3)
        r.check(code == 1 and "不认识" in out, "an unknown option is refused", out)

        # --- dry run must list the payload and transmit nothing
        code, out = bash(UPLOAD, ["deploy@h", "--dry-run"], work3)
        r.check(code == 0, "--dry-run exits 0", out)
        r.check(
            "docker-compose.prod.yml" in out and "ops/deploy/deploy.sh" in out,
            "--dry-run lists what would be uploaded",
            out,
        )
        r.check(
            "未传输" in out and "（--dry-run 不会执行上面两条）" in out,
            "--dry-run says plainly that it did not transmit",
            out,
        )
        r.check(
            "deploy-env/server.env" in out and "github-actions.txt" not in out,
            "uploading deploy-env/server.env does not drag in its neighbour github-actions.txt",
            out,
        )

        # --- the one that matters: a credential file in the payload is refused.
        # The payload now names `deploy-env/server.env` explicitly, so a sibling
        # `.env` is not part of it and the guard rightly ignores it. To exercise
        # the guard the credential has to sit ON a payload path. Rename the
        # template to `.env` and force-add it, which is exactly the accident
        # this guard exists for: someone edits the real file in place and
        # commits it with -f because .gitignore blocked the first attempt.
        sh(["git", "mv", "deploy-env/server.env", "deploy-env/.env"], work3)
        r.check(
            not (work3 / "deploy-env" / "server.env").exists(),
            "  (fixture) the payload path was renamed away",
        )
        # Point the payload at the renamed file so the guard has something to
        # inspect: simulate the case where PAYLOAD lists a file that is creds.
        crippled = work3 / "ops" / "handoff" / "upload-to-server.sh"
        text = crippled.read_text(encoding="utf-8")
        text = text.replace("deploy-env/server.env", "deploy-env/.env")
        crippled.write_text(text, encoding="utf-8", newline="\n")
        (work3 / "deploy-env" / ".env").write_text(
            "MYSQL_PASSWORD=hunter2\n", encoding="utf-8"
        )
        sh(["git", "add", "-A"], work3)
        sh(["git", "add", "-f", "deploy-env/.env"], work3)
        sh(["git", "commit", "-q", "-m", "oops"], work3)
        code, out = bash(UPLOAD, ["deploy@h", "--dry-run"], work3)
        r.check(
            code == 1 and "凭据" in out,
            "a .env named in the payload stops the upload",
            out,
        )
        r.check("deploy-env/.env" in out, "  ...and the offending path is named", out)

        # A template must NOT be caught by the same guard.
        sh(["git", "mv", "deploy-env/.env", "deploy-env/server.env.example"], work3)
        text = crippled.read_text(encoding="utf-8")
        crippled.write_text(
            text.replace("deploy-env/.env", "deploy-env/server.env.example"),
            encoding="utf-8",
            newline="\n",
        )
        sh(["git", "add", "-A"], work3)
        sh(["git", "commit", "-q", "-m", "template"], work3)
        code, out = bash(UPLOAD, ["deploy@h", "--dry-run"], work3)
        r.check(
            code == 0 and "server.env.example" in out,
            "a *.example template is not mistaken for a credential file",
            out,
        )

        # --- missing payload paths are reported together
        work4 = make_repo(tmp_path / "d")
        # Remove a whole payload directory, tracked content and all.
        subprocess.run(
            ["git", "rm", "-r", "-q", "deploy-env"],
            cwd=work4, capture_output=True, encoding="utf-8", errors="replace",
        )
        code, out = bash(UPLOAD, ["deploy@h", "--dry-run"], work4)
        r.check(
            code == 1 and "deploy-env" in out,
            "a missing payload path stops the upload and names it",
            out,
        )

        # --- git archive only ships committed content
        work5 = make_repo(tmp_path / "e")
        (work5 / "docker-compose.yml").write_text("services: {secret: yes}\n", encoding="utf-8")
        sh(["git", "add", "-A"], work5)
        sh(["git", "commit", "-q", "-m", "uncommitted secret"], work5)
        (work5 / "docker-compose.yml").write_text("services: {MYSQL_PASSWORD: hunter2}\n",
                                                  encoding="utf-8")
        code, out = bash(UPLOAD, ["deploy@h", "--dry-run"], work5)
        r.check(code == 0, "dry run still works with uncommitted edits present", out)
        # The listing comes from the archive, so it must reflect HEAD, not the
        # working tree. Assert the changed content is NOT what gets packed.
        r.check(
            "hunter2" not in out,
            "the archive carries committed content, not the working tree (uncommitted edit absent)",
            out,
        )

        # ------------------------------------------------- windows launchers
        # The .cmd files wrap the .sh ones so this works on Windows, where the
        # plain `bash` on PATH is the WSL entry point and fails with a kernel
        # error that has nothing to do with this project.
        #
        # cmd.exe has two traps that are invisible in an editor, both hit while
        # writing these files:
        #
        #   * **LF-only line endings.** cmd.exe then mis-parses the file and
        #     executes comment text as commands, producing "'...' is not
        #     recognized" errors for lines that look like ordinary REM text.
        #   * **A UTF-8 BOM.** cmd.exe emits *nothing at all* -- no error, no
        #     output, exit 0. Measured: identical file, BOM added, empty stdout.
        #
        # Neither is visible in a diff or an editor, so they are asserted here.
        print("\nWindows launchers (.cmd)")

        cmd_dir = REPO / "ops" / "handoff"
        cmd_files = sorted(cmd_dir.glob("*.cmd"))
        r.check(
            len(cmd_files) >= 3,
            f"the .cmd launchers are present ({len(cmd_files)} found)",
        )
        for f in cmd_files:
            raw = f.read_bytes()
            r.check(
                raw[:3] != b"\xef\xbb\xbf",
                f"{f.name}: no BOM (a BOM makes cmd.exe print nothing and exit 0)",
            )
            lf_only = raw.count(b"\n") - raw.count(b"\r\n")
            r.check(
                lf_only == 0,
                f"{f.name}: every line ends CRLF, {lf_only} bare LF found "
                f"(LF-only makes cmd.exe execute comment text)",
            )
            try:
                raw.decode("utf-8")
                decoded = True
            except UnicodeDecodeError:
                decoded = False
            r.check(decoded, f"{f.name}: decodes as UTF-8 (the console here is cp65001)")

        # The launchers must not carry their own argument validation. An earlier
        # version duplicated the usage text and the two copies disagreed: the
        # .cmd returned 0 on a usage error where the .sh returned 2.
        #
        # Run against the REAL repository, not the synthetic fixtures: those hold
        # only the .sh files, so cmd.exe would fail with "file not found" and the
        # comparison would be meaningless. The real tree is also the environment
        # the launcher is actually for.
        #
        # Only argument-validation cases appear here. They fail before any
        # network or filesystem work, so this needs no remote and transmits
        # nothing. cmd.exe is what is under test, so this is Windows-only.
        if os.name == "nt":
            cases = [
                ("push-to-github.sh", "push-to-github.cmd", [], 2),
                ("push-to-github.sh", "push-to-github.cmd", ["https://github.com/x/y.git"], 1),
                ("upload-to-server.sh", "upload-to-server.cmd", [], 2),
                ("upload-to-server.sh", "upload-to-server.cmd", ["deploy@h", "--bogus"], 1),
                ("upload-to-server.sh", "upload-to-server.cmd", ["deploy@h", "--dry-run"], 0),
            ]
            for script, launcher, args, expected in cases:
                sh_code, _ = bash(f"ops/handoff/{script}", args, REPO)
                cmd_code = subprocess.run(
                    ["cmd.exe", "/c", launcher, *args],
                    cwd=REPO / "ops" / "handoff",
                    capture_output=True,
                ).returncode
                label = " ".join(args) or "(no args)"
                r.check(
                    sh_code == expected,
                    f"{script} {label}: the .sh itself gives {expected} (got {sh_code})",
                )
                r.check(
                    cmd_code == sh_code,
                    f"{launcher} {label}: agrees with the .sh (both {sh_code}, launcher gave {cmd_code})",
                )
        else:
            print("  skip  launcher exit-code agreement (not Windows)")

    print(f"\n{r.passed} passed, {r.failed} failed")
    return 1 if r.failed else 0


if __name__ == "__main__":
    sys.exit(main())
