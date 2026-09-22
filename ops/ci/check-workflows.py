#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Structural checks on the GitHub Actions workflows.

    python3 ops/ci/check-workflows.py

This is not a replacement for actionlint, which validates the full schema and can
resolve expression contexts. It checks the rules this repository has decided on,
which actionlint has no way to know about -- the ones where a violation is
perfectly valid YAML and a perfectly valid workflow, and is still wrong here.

Every rule below exists because getting it wrong is quiet:

  * `ssh-keyscan` fetches the host key from the network you are about to trust,
    so it verifies nothing. It looks like a security measure, which is what makes
    it worth banning mechanically rather than remembering.
  * `pull_request_target` runs with a writable token and access to secrets on a
    pull request from a fork.
  * Deploying a mutable tag means a rollback to `latest` is not a rollback to
    anything in particular, and two deploys of the same name can be different
    images.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

# Substrings that must not appear in any workflow. Plain text rather than YAML
# walking, because these are the kind of mistake that gets written in a comment
# explaining why it is not used -- and this check should not have to tell the
# difference between explaining and doing.
FORBIDDEN = {
    "ssh-keyscan": "the host key would be fetched from the network being trusted",
    "pull_request_target": "runs with secrets and a writable token on fork PRs",
    "StrictHostKeyChecking=no": "disables host verification entirely",
    "insecure_skip_verify": "disables TLS verification",
}


def texts() -> dict[str, str]:
    return {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(WORKFLOWS.glob("*.yml"))
    }


def strip_comments(text: str) -> str:
    """Drop whole-line YAML comments before scanning for forbidden strings.

    Without this the check fires on its own documentation: release.yml explains
    in a comment that `ssh-keyscan` is not used, and a naive substring search
    reports that as a violation. A check that cannot tell an explanation from an
    act gets suppressed the first time it cries wolf, and a suppressed check is
    worse than no check -- it still looks like coverage.

    Only whole-line comments are dropped. A `#` inside a value is left alone, so
    a forbidden string in actual configuration is still caught. That means a
    forbidden string trailing a real line survives this filter, which is the
    right way round: a false positive is visible and fixable, a false negative is
    not.
    """
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )


def triggers(document: dict) -> dict:
    # PyYAML resolves the bare key `on` to the boolean True, which is a YAML 1.1
    # behaviour GitHub's parser does not share.
    return document.get("on") or document.get(True) or {}


def check_ci(document: dict, failures: list[str]) -> None:
    found = triggers(document)
    for trigger in ("push", "pull_request", "workflow_dispatch", "workflow_call"):
        if trigger not in found:
            failures.append(f"ci.yml: trigger {trigger!r} is missing")

    # The gate is only meaningful if the jobs it gates are still there.
    expected = {"contracts", "abi-drift", "web", "indexer-e2e", "format"}
    actual = set((document.get("jobs") or {}).keys())
    missing = expected - actual
    if missing:
        failures.append(f"ci.yml: jobs removed: {', '.join(sorted(missing))}")


def check_release(document: dict, failures: list[str]) -> None:
    jobs = document.get("jobs") or {}

    gate = jobs.get("gate") or {}
    if gate.get("uses") != "./.github/workflows/ci.yml":
        failures.append("release.yml: the gate job does not call the CI workflow")

    build = jobs.get("build") or {}
    if "gate" not in _needs(build):
        failures.append("release.yml: build does not depend on the gate")

    deploy = jobs.get("deploy") or {}
    needed = _needs(deploy)
    for required in ("build", "scan"):
        if required not in needed:
            failures.append(f"release.yml: deploy does not depend on {required}")

    if (deploy.get("environment") or "") != "production":
        failures.append("release.yml: deploy is not gated on the production environment")

    concurrency = document.get("concurrency") or {}
    if concurrency.get("cancel-in-progress"):
        failures.append("release.yml: cancelling a running release can leave a half-deploy")
    if (deploy.get("concurrency") or {}).get("group") != "deploy-production":
        failures.append("release.yml: deploy is not serialised on the deploy-production group")

    # Whatever the build produces, deploy must not consume a moving tag.
    blob = yaml.safe_dump(document)
    if "needs.build.outputs.version" not in blob:
        failures.append("release.yml: deploy does not use the immutable build version")


def check_no_mutable_deploy(failures: list[str]) -> None:
    """`latest` may be published, but it must never be what a deploy reads."""
    text = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    for line in text.splitlines():
        stripped = line.strip()
        # Only the deploy step matters: publishing `latest` for humans is fine.
        if "deploy.sh" in stripped and "latest" in stripped:
            failures.append("release.yml: the deploy command references a mutable tag")


def check_rollback(document: dict, failures: list[str]) -> None:
    found = triggers(document)
    dispatch = found.get("workflow_dispatch")
    if not isinstance(dispatch, dict) or "tag" not in (dispatch.get("inputs") or {}):
        failures.append("rollback.yml: workflow_dispatch has no `tag` input")

    jobs = document.get("jobs") or {}
    job = next(iter(jobs.values()), {}) if jobs else {}
    if (job.get("environment") or "") != "production":
        failures.append("rollback.yml: rollback is not gated on the production environment")
    if (job.get("concurrency") or {}).get("group") != "deploy-production":
        failures.append("rollback.yml: rollback does not share the deploy lock")


def _needs(job: dict) -> list[str]:
    needs = job.get("needs")
    if needs is None:
        return []
    return [needs] if isinstance(needs, str) else list(needs)


def main() -> int:
    failures: list[str] = []
    documents = {}

    for name, text in texts().items():
        code = strip_comments(text)
        for needle, why in FORBIDDEN.items():
            if needle in code:
                failures.append(f"{name}: contains {needle!r} -- {why}")
        try:
            documents[name] = yaml.safe_load(text)
        except yaml.YAMLError as error:
            failures.append(f"{name}: does not parse: {error}")

    if "ci.yml" in documents:
        check_ci(documents["ci.yml"], failures)
    if "release.yml" in documents:
        check_release(documents["release.yml"], failures)
        check_no_mutable_deploy(failures)
    if "rollback.yml" in documents:
        check_rollback(documents["rollback.yml"], failures)

    print(f"workflows checked: {', '.join(documents)}")

    if failures:
        print(f"\n{len(failures)} problem(s):")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("\nok: workflow invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
