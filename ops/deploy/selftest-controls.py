"""Negative controls for ops/deploy/selftest.sh.

Breaks the ordering properties the zero-downtime claim rests on and asserts that
the shell self-test notices. A test suite that passes on a correct deploy script
proves nothing unless it also fails on an incorrect one.

Why this runs against a copy
----------------------------

An earlier version of this file edited `ops/deploy/deploy.sh` in place and
restored it afterwards. That is unsafe in two distinct ways, and both bit:

  * **Restore is not the inverse of mutate.** The harness read the file, assumed
    it was the pristine version, and wrote it back at the end. On a working tree
    where the file was *already* modified -- by an interrupted earlier run, or by
    a concurrent process -- "restore" faithfully restored the modification. The
    final byte-for-byte check then compared the file against that same corrupted
    baseline and reported success. **A check that compares against the thing it
    is supposed to be checking is not a check.**

  * **An interrupted run leaves the fault on disk.** And a deploy script carrying
    an injected fault is worse than a failing test: the next person finds an
    unexplained edit to a committed file and has to reconstruct where it came
    from. That happened here, twice, and cost real time.

So the harness now copies `ops/deploy` and `ops/nginx` into a temporary directory
and mutates the copy. The tracked tree is never opened for writing, which makes
the failure mode above structurally impossible rather than merely guarded
against. `selftest.sh` resolves its siblings through `$here`, so a copied tree
needs no modification to run.

    usage: selftest-controls.py        # exit 0 when every control is caught
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]

# The `bash` that runs the copied self-test.
#
# Git for Windows ships bash at a fixed path that is not on PATH; everywhere else
# (which includes the Linux runner CI uses) it is just `bash`.
#
# This was hardcoded to the Windows path, so on Linux the step that runs this file
# died with FileNotFoundError before it checked anything -- a control that could
# never pass where it ran, reporting nothing about the self-test. It stayed hidden
# because the step before it in the job, shellcheck, failed first and the rest were
# skipped.
BASH = r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else "bash"


def run_in(root: pathlib.Path) -> tuple[int, str]:
    """Run the self-test as it exists under `root`."""
    result = subprocess.run(
        [BASH, "-c", f"bash {root.as_posix()}/ops/deploy/selftest.sh"],
        capture_output=True,
        text=True,
        cwd=REPO,
        encoding="utf-8",
    )
    return result.returncode, (result.stdout or "") + (result.stderr or "")


def mutate(deploy: pathlib.Path, old: str, new: str) -> None:
    """Apply one injected fault to the copied script."""
    original = deploy.read_text(encoding="utf-8")
    mutated = original.replace(old, new)
    assert mutated != original, f"pattern not found in the copy: {old!r}"
    deploy.write_text(mutated, encoding="utf-8", newline="\n")


# Each case: (name, the fault, what it should make the self-test notice).
#
# Every one of these produces a deploy that reports success. That is the point:
# the properties being protected are invisible from outside, so a fault that
# breaks them does not look like a fault.
CASES: list[tuple[str, str, str]] = [
    (
        "traffic moves before the health gate",
        # Reloading nginx before establishing that the target slot works is the
        # exact failure the whole design exists to prevent.
        (
            'log "gating $target_service on /api/health (budget ${health_timeout}s)"',
            'log "SWITCHING EARLY (injected fault)"\n'
            '"$here/../nginx/render-upstream.sh" "$target_slot" || true\n'
            'log "gating $target_service on /api/health (budget ${health_timeout}s)"',
        ),
    ),
    (
        "the old slot is stopped after a successful deploy",
        # Every assertion about active-tag, active-slot and the log would still
        # pass -- while rollback silently degrades from a config switch to a cold
        # start. This is why it needs a dedicated assertion.
        (
            'append_deploy_log "ok tag=$tag slot=$target_slot"',
            'compose stop "web-$active_slot" || true\nappend_deploy_log "ok tag=$tag slot=$target_slot"',
        ),
    ),
    (
        "migrate runs after the slot starts",
        # The new version would start against a schema without its tables.
        (
            "if ! compose run --rm migrate; then",
            'if ! compose up -d --no-deps "$target_service"; then',
        ),
    ),
    (
        "a failed health gate still records success",
        # An abort that publishes a version is worse than one that does not: the
        # version series would claim a release is live that never served.
        (
            'die "web-$target_slot never became healthy, so it was stopped. '
            'Traffic was never moved; web-$active_slot is still serving '
            'tag=${previous_tag:-unknown}."',
            'write_state active-tag "$tag"',
        ),
    ),
]


def main() -> int:
    failures = 0

    def ok(message: str) -> None:
        print(f"  ok   {message}")

    def bad(message: str) -> None:
        nonlocal failures
        print(f"  FAIL {message}")
        failures += 1

    # A copy of the tree the self-test needs. Nothing below writes to REPO.
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        for name in ("deploy", "nginx"):
            shutil.copytree(REPO / "ops" / name, root / "ops" / name)
        deploy = root / "ops" / "deploy" / "deploy.sh"

        pristine = deploy.read_bytes()

        code, output = run_in(root)
        if code == 0:
            ok("the unmodified copy passes")
        else:
            bad(f"the unmodified copy should pass, exit {code}")
            print(output[-2000:])

        for name, (old, new) in CASES:
            deploy.write_bytes(pristine)
            try:
                mutate(deploy, old, new)
            except AssertionError as error:
                bad(f"setup for {name!r}: {error}")
                continue

            code, output = run_in(root)
            caught = [
                line.strip() for line in output.splitlines() if line.strip().startswith("FAIL")
            ]
            if code != 0 and caught:
                ok(f"{name}  (caught by {len(caught)} assertion(s))")
            else:
                bad(f"{name}: the self-test did not notice (exit {code})")

        deploy.write_bytes(pristine)
        code, _ = run_in(root)
        if code == 0:
            ok("the copy passes again once the fault is removed")
        else:
            bad("the copy does not pass after the fault is removed")

        # The whole reason for the copy. Assert it, so a future edit that
        # reintroduces in-place mutation fails here instead of on someone's
        # working tree.
        if deploy.read_bytes() == pristine:
            ok("the copy was left in its original state (nothing was left behind)")
        else:
            bad("the copy was left modified")

    print(f"\n{len(CASES) + 3 - failures} passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
