"""Negative controls for ops/deploy/selftest.sh.

Breaks the ordering property the zero-downtime claim rests on and asserts that
the shell self-test notices. A test suite that passes on a correct deploy script
proves nothing unless it also fails on an incorrect one.
"""

import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
DEPLOY = REPO / "ops" / "deploy" / "deploy.sh"
ORIGINAL = DEPLOY.read_text(encoding="utf-8")

# `bash` from Git for Windows; the scripts are POSIX bash.
BASH = r"C:\Program Files\Git\bin\bash.exe"


def run_selftest() -> tuple[int, str]:
    result = subprocess.run(
        [BASH, "-c", "bash ops/deploy/selftest.sh"],
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    return result.returncode, result.stdout + result.stderr


def replace(old: str, new: str) -> None:
    text = ORIGINAL.replace(old, new)
    assert text != ORIGINAL, f"pattern not found: {old!r}"
    DEPLOY.write_text(text, encoding="utf-8")


CASES = [
    (
        "traffic moves before the health gate",
        # The failure this whole design exists to prevent: reloading nginx
        # before establishing that the target slot works.
        lambda: replace(
            'log "gating $target_service on /api/health (budget ${health_timeout}s)"',
            'log "SWITCHING EARLY (injected fault)"\n"$here/../nginx/render-upstream.sh" "$target_slot" || true\n'
            'log "gating $target_service on /api/health (budget ${health_timeout}s)"',
        ),
    ),
    (
        "the old slot is stopped after a successful deploy",
        # Would make rollback a cold start while every assertion about
        # active-tag still passes -- which is why it needs its own check.
        lambda: replace(
            'append_deploy_log "ok tag=$tag slot=$target_slot"',
            'compose stop "web-$active_slot" || true\nappend_deploy_log "ok tag=$tag slot=$target_slot"',
        ),
    ),
    (
        "migrate runs after the slot starts",
        # Migrations must precede the new version, or the new version starts
        # against a schema that does not have its tables yet.
        lambda: replace(
            'if ! compose run --rm migrate; then',
            'if ! compose up -d --no-deps "$target_service"; then',
        ),
    ),
    (
        "a failed health gate still records success",
        # The abort property: a gate that fails must not publish a version.
        lambda: replace(
            'die "web-$target_slot never became healthy, so it was stopped. Traffic was never moved; web-$active_slot is still serving tag=${previous_tag:-unknown}."',
            'write_state active-tag "$tag"',
        ),
    ),
]


def main() -> int:
    failures = 0

    code, output = run_selftest()
    if code == 0:
        print("  ok   unmodified script passes")
    else:
        print(f"  FAIL unmodified script should pass, exit {code}")
        print(output[-2000:])
        failures += 1

    for name, mutate in CASES:
        DEPLOY.write_text(ORIGINAL, encoding="utf-8")
        try:
            mutate()
        except AssertionError as error:
            print(f"  SETUP FAIL  {name}: {error}")
            failures += 1
            continue

        code, output = run_selftest()
        failed = [line.strip() for line in output.splitlines() if line.strip().startswith("FAIL")]
        if code != 0 and failed:
            print(f"  ok   {name}  (caught by {len(failed)} assertion(s))")
        else:
            print(f"  FAIL {name}: the selftest did not notice (exit {code})")
            failures += 1

    DEPLOY.write_text(ORIGINAL, encoding="utf-8")
    code, _ = run_selftest()
    if code == 0:
        print("  ok   restored script passes")
    else:
        print("  FAIL restored script does not pass")
        failures += 1

    print(f"\n{len(CASES) + 2 - failures} passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
