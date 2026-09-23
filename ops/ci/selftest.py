"""Negative controls for ops/ci/check-workflows.py.

Each case breaks exactly one invariant and asserts the checker reports it. A
checker that cannot fail is not evidence, so these run together.

Written as a file rather than an inline command because the workflow text
contains `${{ ... }}`, which PowerShell interpolates before Python ever sees it.
"""

import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
CI = REPO / ".github" / "workflows" / "ci.yml"
REL = REPO / ".github" / "workflows" / "release.yml"
ROLL = REPO / ".github" / "workflows" / "rollback.yml"

ORIGINALS = {p: p.read_text(encoding="utf-8") for p in (CI, REL, ROLL)}


def restore() -> None:
    for path, text in ORIGINALS.items():
        write_lf(path, text)


def write_lf(path: pathlib.Path, text: str) -> None:
    """Write workflow text back with LF endings, whatever the platform default is.

    These cases mutate the REAL workflow files (the checker reads them from the
    repository, so a copy would not exercise it) and restore them afterwards.
    Without `newline="\n"`, Python's text mode translates every `\\n` to `\\r\\n`
    on Windows, so the restore does not restore: the tree comes back dirty with
    CRLF where `.gitattributes` says `eol=lf`, `git diff` shows nothing while
    `git status` shows three modified files, and the next `prettier --check`
    fails on files this test touched but nobody edited. A test that leaves the
    tree in a state it cannot explain is worse than no test.
    """
    path.write_text(text, encoding="utf-8", newline="\n")


def check() -> tuple[int, list[str]]:
    result = subprocess.run(
        [sys.executable, "ops/ci/check-workflows.py"],
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    findings = [line.strip() for line in result.stdout.splitlines() if line.strip().startswith("-")]
    return result.returncode, findings


def rewrite(path: pathlib.Path, old: str, new: str) -> None:
    text = ORIGINALS[path].replace(old, new)
    assert text != ORIGINALS[path], f"no change made to {path.name}: {old!r} not found"
    write_lf(path, text)


def drop_deploy_lock() -> None:
    """Remove only the deploy job's concurrency block, keeping the YAML valid.

    A mutation that leaves the file unparseable also satisfies the checker, but
    for the wrong reason -- it would report a YAML error rather than the missing
    lock, and the test would pass without ever exercising the rule.
    """
    lines = ORIGINALS[REL].splitlines(keepends=True)
    # The deploy job's block: an indented `concurrency:` followed by its group.
    start = next(
        index
        for index, line in enumerate(lines)
        if line.strip() == "concurrency:"
        and line.startswith("    ")
        and "deploy-production" in "".join(lines[index : index + 3])
    )
    del lines[start : start + 3]
    mutated = "".join(lines)
    assert mutated != ORIGINALS[REL], "the deploy lock block was not found"
    write_lf(REL, mutated)


CASES = [
    (
        "deploy reads a mutable tag",
        lambda: rewrite(REL, "deploy.sh '${" + "{ needs.build.outputs.version }}'", "deploy.sh latest"),
        "mutable tag",
    ),
    (
        "deploy lock removed",
        drop_deploy_lock,
        "serialised",
    ),
    (
        "gate no longer calls ci.yml",
        lambda: rewrite(REL, "uses: ./.github/workflows/ci.yml", "uses: ./.github/workflows/nope.yml"),
        "does not call the CI workflow",
    ),
    (
        "deploy no longer needs scan",
        lambda: rewrite(REL, "needs: [build, scan]", "needs: [build]"),
        "does not depend on scan",
    ),
    (
        "rollback uses a different lock",
        lambda: rewrite(ROLL, "group: deploy-production", "group: rollback-alone"),
        "does not share the deploy lock",
    ),
    (
        "ci.yml loses workflow_call",
        lambda: rewrite(CI, "  workflow_call:\n", ""),
        "workflow_call' is missing",
    ),
    (
        "ssh-keyscan reintroduced",
        lambda: rewrite(REL, "          printf '%s\\n'", "          ssh-keyscan -H host\n          printf '%s\\n'"),
        "ssh-keyscan",
    ),
    (
        "host verification disabled",
        lambda: rewrite(REL, "rsync -az --delete", "rsync -az --delete -e 'ssh -o StrictHostKeyChecking=no'"),
        "StrictHostKeyChecking=no",
    ),
]


def main() -> int:
    failures = 0

    for name, mutate, expected in CASES:
        restore()
        try:
            mutate()
        except AssertionError as error:
            print(f"  SETUP FAIL  {name}: {error}")
            failures += 1
            continue

        code, findings = check()
        hit = any(expected in finding for finding in findings)
        if code != 0 and hit:
            print(f"  ok   {name}")
        else:
            print(f"  FAIL {name}: exit {code}, findings {findings}")
            failures += 1

    restore()
    code, findings = check()
    if code == 0:
        print("  ok   clean tree passes")
    else:
        print(f"  FAIL clean tree passes: {findings}")
        failures += 1

    print(f"\n{len(CASES) + 1 - failures} passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
