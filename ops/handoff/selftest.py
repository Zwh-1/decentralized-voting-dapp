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
    (work / "docker-compose.external-db.yml").write_text("services: {}\n", encoding="utf-8")
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
        # An EXPLICIT list, not glob("*.cmd"). The earlier glob counted
        # _q.cmd -- a throwaway probe whose only job was to measure how
        # cmdcmdline looks under different invocation forms -- as a shipped
        # launcher, so the suite reported "5 launchers" and checked the BOM and
        # line endings of a file no user ever runs. Counting files that happen
        # to share an extension is not the same as checking the files that
        # matter; the list is written out so adding a launcher is a deliberate
        # act rather than a side effect of dropping a file in the directory.
        launcher_names = [
            "_bash-path.cmd",
            "_pause-if-doubleclicked.cmd",
            "push-to-github.cmd",
            "upload-to-server.cmd",
        ]
        cmd_files = [cmd_dir / n for n in launcher_names]
        missing_cmd = [p.name for p in cmd_files if not p.exists()]
        r.check(
            not missing_cmd,
            f"the {len(launcher_names)} .cmd launchers are present"
            + (f" (missing: {', '.join(missing_cmd)})" if missing_cmd else ""),
        )
        for f in cmd_files:
            if not f.exists():
                continue
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
            # PURE ASCII, and this one is not cosmetic. The committed revision
            # of these launchers carried Chinese in REM lines and echo text.
            # cmd.exe decodes a .cmd with the console's OEM code page (936
            # here), so the UTF-8 bytes were misread and the tail of each line
            # was executed as a command:
            #
            #   'F' is not recognized as an internal or external command
            #   'ps\handoff\' is not recognized ...
            #
            # Every run died with exit 255 before printing anything usable.
            # Decoding as UTF-8 -- the old assertion -- PASSES on that file, so
            # the suite stayed green while the launcher was completely broken.
            # ASCII is the only encoding that parses identically under cp936
            # and cp65001, which is why all Chinese output lives in the .sh.
            try:
                raw.decode("ascii")
                is_ascii = True
            except UnicodeDecodeError as exc:
                is_ascii = False
                ascii_detail = f"first non-ASCII byte at offset {exc.start}"
            r.check(
                is_ascii,
                f"{f.name}: is pure ASCII (non-ASCII in a .cmd is decoded as the "
                f"OEM code page and executed as commands)"
                + ("" if is_ascii else f" -- {ascii_detail}"),
            )

        # ---------------------------------------------------- native .bat files
        # These are NOT held to the ASCII rule the .cmd files are held to. They
        # carry Chinese output by design, and that is safe only because each one
        # runs `chcp 65001` before any Chinese line is parsed. What must hold
        # instead:
        #
        #   * UTF-8 WITHOUT a BOM -- a BOM makes cmd.exe print nothing, exit 0.
        #   * CRLF -- LF-only makes cmd.exe execute comment text as commands.
        #   * the chcp appears before the first non-ASCII byte.
        #
        # The last one is the actual invariant the ASCII rule was protecting.
        # Asserting it directly is more honest than asserting "ASCII" on a file
        # that deliberately is not ASCII, and it catches the real failure: a
        # .bat that prints Chinese under a cp936 console comes out as mojibake,
        # or worse, with the tail of each line executed as a command.
        print("\nNative .bat scripts")
        bat_names = ["push-to-github.bat", "upload-to-server.bat"]
        for name in bat_names:
            f = cmd_dir / name
            r.check(f.exists(), f"{name}: present")
            if not f.exists():
                continue
            raw = f.read_bytes()
            r.check(
                raw[:3] != b"\xef\xbb\xbf",
                f"{name}: no BOM (a BOM makes cmd.exe print nothing and exit 0)",
            )
            lf_only = raw.count(b"\n") - raw.count(b"\r\n")
            r.check(
                lf_only == 0,
                f"{name}: every line ends CRLF, {lf_only} bare LF found",
            )
            text = raw.decode("utf-8", errors="replace")
            chcp_at = text.find("chcp 65001")
            # First non-ASCII character, as an index into the decoded text.
            first_non_ascii = next(
                (i for i, ch in enumerate(text) if ord(ch) > 127), None
            )
            if chcp_at == -1:
                r.check(False, f"{name}: switches the console to UTF-8 with chcp 65001")
            elif first_non_ascii is None:
                r.check(
                    True,
                    f"{name}: chcp 65001 present (no non-ASCII output to order it against)",
                )
            else:
                r.check(
                    chcp_at < first_non_ascii,
                    f"{name}: chcp 65001 runs before the first non-ASCII character "
                    f"(chcp at {chcp_at}, first non-ASCII at {first_non_ascii})",
                )

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

            # ------------------------------------------- native .bat variants
            # push-to-github.bat and upload-to-server.bat are standalone
            # reimplementations for Windows, not wrappers: they call git, tar,
            # ssh and scp directly and never invoke bash. That is the point of
            # them -- the .cmd launchers had to reach into Git for Windows for a
            # bash, and every cmd/bash boundary detail (code page, BOM, line
            # endings, %~dp0 expansion order) was a place to get it wrong.
            #
            # Two implementations of the same rules WILL drift, so the drift is
            # what gets asserted: for each case the .bat must produce the same
            # exit code as the .sh. This is the same technique already used for
            # the .cmd launchers, and the same reason: an earlier revision had
            # the .cmd return 0 on a usage error where the .sh returned 2.
            #
            # Same restriction as above -- argument-validation cases only, so
            # nothing here touches the network or transmits anything.
            bat_cases = [
                ("push-to-github", [], 2),
                ("push-to-github", ["https://github.com/x/y.git"], 1),
                ("push-to-github", ["garbage"], 1),
                ("upload-to-server", [], 2),
                ("upload-to-server", ["noat"], 1),
                ("upload-to-server", ["deploy@h", "--port", "abc"], 1),
                ("upload-to-server", ["deploy@h", "--dest", "rel/path"], 1),
                ("upload-to-server", ["deploy@h", "--bogus"], 1),
                ("upload-to-server", ["deploy@h", "--dry-run"], 0),
            ]
            for stem, args, expected in bat_cases:
                sh_code, _ = bash(f"ops/handoff/{stem}.sh", args, REPO)
                bat_code = subprocess.run(
                    ["cmd.exe", "/c", f"{stem}.bat", *args],
                    cwd=REPO / "ops" / "handoff",
                    capture_output=True,
                ).returncode
                label = " ".join(args) or "(no args)"
                r.check(
                    sh_code == expected,
                    f"{stem}.sh {label}: gives {expected} (got {sh_code})",
                )
                r.check(
                    bat_code == sh_code,
                    f"{stem}.bat {label}: agrees with the .sh (both {sh_code}, .bat gave {bat_code})",
                )

            # ------------------------------------------- .bat credential guard
            # The guard is the entire value of both scripts, and until now only
            # the .sh side had it exercised. That gap shipped a real bug: the
            # first actual `push-to-github.bat` run against the real repository
            # REFUSED to push, because `findstr /e /c:".example"` treats "." as
            # a wildcard and so flagged .env.example, contracts/.env.example and
            # web/.env.example -- three files that are supposed to be committed.
            # A guard that blocks its own intended action trains people to
            # bypass it, so both directions are asserted here, against a real
            # git repository built by the same fixture the .sh tests use.
            #
            # Both directions matter and they fail differently:
            #   * a *.example template wrongly blocked -> the script cannot do
            #     its job at all;
            #   * a real .env wrongly allowed -> credentials get pushed.
            guard_root = tmp_path / "bat-guard"
            guard_root.mkdir()
            guard_work = make_repo(guard_root)
            # The .bat files under test, plus their helpers, into the fixture.
            for name in (
                "push-to-github.bat",
                "upload-to-server.bat",
                "_pause-if-doubleclicked.cmd",
                "_parent-name.ps1",
                "push-to-github.sh",
                "upload-to-server.sh",
            ):
                shutil.copy2(REPO / "ops" / "handoff" / name, guard_work / "ops" / "handoff" / name)
            sh(["git", "add", "-A"], guard_work)
            sh(["git", "commit", "-q", "-m", "add bat"], guard_work)

            def run_bat(stem, args, work):
                return subprocess.run(
                    ["cmd.exe", "/c", f"{stem}.bat", *args],
                    cwd=work / "ops" / "handoff",
                    capture_output=True,
                    encoding="utf-8",
                    errors="replace",
                )

            # (a) template present, no real .env: the guard must NOT fire.
            #     --dry-run keeps this off the network entirely.
            ok = run_bat("upload-to-server", ["deploy@h", "--dry-run"], guard_work)
            r.check(
                ok.returncode == 0,
                "upload-to-server.bat: .env.example / server.env are NOT treated as "
                f"credentials (exit 0 expected, got {ok.returncode})",
                ok.stdout + ok.stderr,
            )

            # (b) a real .env inside the payload must stop the upload. Placed at
            #     ops/.env so it is genuinely inside what gets packed -- a .env at
            #     the repository root would not be transmitted anyway, so
            #     blocking it would prove nothing.
            (guard_work / "ops" / ".env").write_text("SECRET=real\n", encoding="utf-8")
            sh(["git", "add", "-f", "ops/.env"], guard_work)
            sh(["git", "commit", "-q", "-m", "leak"], guard_work)
            bad = run_bat("upload-to-server", ["deploy@h", "--dry-run"], guard_work)
            r.check(
                bad.returncode != 0,
                "upload-to-server.bat: a tracked .env inside the payload STOPS the upload",
                bad.stdout + bad.stderr,
            )
            r.check(
                "ops/.env" in (bad.stdout + bad.stderr),
                "upload-to-server.bat: ...and names the offending path",
                bad.stdout + bad.stderr,
            )

            # (c) same two directions for the push guard. The fixture's
            #     .env.example is tracked and must not block; then a real .env
            #     must block.
            (guard_work / "ops" / ".env").unlink()
            sh(["git", "rm", "-q", "--cached", "ops/.env"], guard_work)
            (guard_work / ".gitignore").write_text("", encoding="utf-8")
            sh(["git", "add", "-A"], guard_work)
            sh(["git", "commit", "-q", "-m", "clean"], guard_work)

            push_ok = run_bat("push-to-github", ["git@example.invalid:x/y.git"], guard_work)
            r.check(
                ".env.example" not in (push_ok.stdout + push_ok.stderr),
                "push-to-github.bat: a tracked .env.example is NOT reported as a credential",
                push_ok.stdout + push_ok.stderr,
            )

            (guard_work / ".env").write_text("SECRET=real\n", encoding="utf-8")
            sh(["git", "add", "-f", ".env"], guard_work)
            sh(["git", "commit", "-q", "-m", "leak"], guard_work)
            push_bad = run_bat("push-to-github", ["git@example.invalid:x/y.git"], guard_work)
            r.check(
                push_bad.returncode != 0,
                "push-to-github.bat: a tracked .env STOPS the push",
                push_bad.stdout + push_bad.stderr,
            )

            # ---------------------------------------------------- pause probe
            # The launchers must pause for a double-click and NOT pause for a
            # programmatic call. Only the second half is testable here: a real
            # double-click cannot be manufactured from a test process, which is
            # exactly why the previous cmdcmdline-matching probe shipped
            # unverified.
            #
            # What IS covered: PAUSE_ALWAYS forces the pause path, so the
            # decision variable and the `pause` call are exercised. The
            # detection itself is measured separately (see the note printed
            # below); a wrong answer there means a missing or spurious pause,
            # never a wrong upload.
            probe = REPO / "ops" / "handoff" / "_pause-if-doubleclicked.cmd"
            r.check(
                probe.exists(),
                "the pause probe exists (the launchers call it by name)",
            )

            # Run through `call` with a separate `echo` statement rather than one
            # long `cmd /c a & echo %VAR%` line. cmd expands %VAR% while parsing
            # the whole line, which happens BEFORE the probe runs, so the naive
            # form always printed the literal "%PAUSE_NEEDED%" and could never
            # observe the result. Nested via a temporary .cmd instead, where the
            # echo is its own line and expands after the call returns.
            probe_script = REPO / "ops" / "handoff" / "_pause-probe-test.cmd"
            probe_script.write_text(
                "@echo off\r\n"
                "call \"%~dp0_pause-if-doubleclicked.cmd\"\r\n"
                "echo RESULT=[%PAUSE_NEEDED%]\r\n",
                encoding="ascii",
                newline="",
            )
            try:
                forced = subprocess.run(
                    ["cmd.exe", "/c", probe_script.name],
                    cwd=REPO / "ops" / "handoff",
                    capture_output=True,
                    text=True,
                    errors="replace",
                    env={**os.environ, "PAUSE_ALWAYS": "1"},
                )
                r.check(
                    "RESULT=[1]" in forced.stdout,
                    "PAUSE_ALWAYS=1 makes the probe ask for a pause (the pause path is reachable)",
                    forced.stdout,
                )

                # A programmatic call must not pause, or every automated caller of
                # these launchers hangs forever. This is the failure mode that
                # matters most, so it is asserted rather than assumed.
                #
                # The timeout turns a regression into a readable failure rather
                # than a hung suite: if the probe ever asks for a pause here, the
                # real launcher's `pause` would block on stdin forever.
                not_forced = subprocess.run(
                    ["cmd.exe", "/c", probe_script.name],
                    cwd=REPO / "ops" / "handoff",
                    capture_output=True,
                    text=True,
                    errors="replace",
                    env={k: v for k, v in os.environ.items() if k != "PAUSE_ALWAYS"},
                    timeout=120,
                )
                r.check(
                    "RESULT=[]" in not_forced.stdout,
                    "a programmatic call does NOT request a pause (automation cannot hang)",
                    not_forced.stdout,
                )
            finally:
                probe_script.unlink(missing_ok=True)

            print(
                "  note  the double-click detection itself is verified by hand, not here:\n"
                "        a real double-click puts explorer.exe as this cmd.exe's parent,\n"
                "        measured with a launcher left on the desktop and started by Explorer."
            )
        else:
            print("  skip  launcher exit-code agreement (not Windows)")

    print(f"\n{r.passed} passed, {r.failed} failed")
    return 1 if r.failed else 0


if __name__ == "__main__":
    sys.exit(main())
