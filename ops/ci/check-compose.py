"""Checks that the development overlay cannot leak into production.

Why this exists
---------------

`docker compose up` automatically loads `docker-compose.override.yml`. Naming any
`-f` replaces the default file set, so the production command correctly skips it —
but "correctly" here rests on every future production invocation remembering to
pass both flags. That is a convention, and conventions drift.

The failure is quiet and plausible-looking. A production command that forgets one
`-f`, or an override that grows a `web-blue` key, would give a server:

  - the application port published straight to the internet, bypassing nginx
    entirely (including the `location = /api/metrics { return 403; }` rule),
  - `RPC_URL` pointing at `host.docker.internal`, which does not exist on a cloud
    host, so the indexer reads nothing and the site shows no polls,
  - a single `web` topology where the deploy scripts expect two slots.

None of those are visible in a `docker compose up` that reports success.

This checker is deliberately narrow: it asserts the *isolation*, not general
compose correctness. `docker compose config` already validates syntax and schemas,
and `ops/deploy/selftest.sh` covers the deploy ordering.

    usage: check-compose.py            # exit 0 when the isolation holds
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]

BASE = ["docker", "compose"]
PROD = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.prod.yml"]

PROD_SERVICES = {"mysql", "migrate", "web-blue", "web-green", "nginx", "indexer"}

# Values the production file set demands at interpolation time.
#
# `docker-compose.prod.yml` writes `${RPC_URL:?}` and `${CHAIN_ID:?}` on both web
# slots, so compose refuses to render at all when they are absent. That is
# deliberate -- a server whose .env went missing would otherwise start a slot
# that reads 127.0.0.1:8545 on chain 31337 and still passes its health gate.
# The checker therefore has to supply them, exactly as a real host's .env does.
#
# They are obviously fake on purpose: this checker asserts the SHAPE of the
# rendered config and must never depend on, or encode, a real endpoint.
REQUIRED_ENV = {
    "WEB_IMAGE": "example/voting-web",
    "RPC_URL": "https://rpc.invalid",
    "CHAIN_ID": "11155111",
}


def render(args: list[str]) -> str:
    """Render the effective configuration for the given file set."""
    result = subprocess.run(
        [*args, "config"],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**__import__("os").environ, **REQUIRED_ENV},
    )
    if result.returncode != 0:
        raise SystemExit(f"compose config failed for {' '.join(args)}:\n{result.stderr}")
    return result.stdout


def services(args: list[str]) -> set[str]:
    result = subprocess.run(
        [*args, "config", "--services"],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**__import__("os").environ, **REQUIRED_ENV},
    )
    if result.returncode != 0:
        raise SystemExit(f"compose config --services failed:\n{result.stderr}")
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def find_leaks(prod_config: str) -> list[str]:
    """Every way the development overlay could have reached production.

    Separated from the rendering so it can be exercised directly by the
    self-test below -- a detector that has never been shown a positive sample is
    not known to detect anything.
    """
    leaks = []

    if re.search(r"host-gateway|host\.docker\.internal", prod_config):
        leaks.append(
            "production references the host gateway: RPC_URL would point at a "
            "host that does not exist on a server"
        )

    # A published application port means nginx is bypassed, and with it the rule
    # that refuses /api/metrics.
    for published in re.findall(r"published:\s*\"?(\d+)\"?", prod_config):
        if published == "3000":
            leaks.append("production publishes port 3000: nginx is bypassed")

    if "3307" in prod_config:
        leaks.append("production publishes MySQL on 3307")

    if "docker-compose.override.yml" in prod_config:
        leaks.append("production config names the development override")

    return leaks


def main() -> int:
    failures = 0

    def ok(message: str) -> None:
        print(f"  ok   {message}")

    def bad(message: str) -> None:
        nonlocal failures
        print(f"  FAIL {message}")
        failures += 1

    print("compose development/production isolation")

    prod_config = render(PROD)
    local_config = render(BASE)

    # -- production must be clean -------------------------------------------
    leaks = find_leaks(prod_config)
    if leaks:
        for leak in leaks:
            bad(leak)
    else:
        ok("production carries none of the development overlay")

    prod_services = services(PROD)
    if prod_services == PROD_SERVICES:
        ok(f"production services are exactly {sorted(PROD_SERVICES)}")
    else:
        bad(
            f"production services differ: missing {sorted(PROD_SERVICES - prod_services)}, "
            f"unexpected {sorted(prod_services - PROD_SERVICES)}"
        )

    if "web" in prod_services:
        bad("the single-slot `web` service is active in production")
    else:
        ok("the single-slot `web` service is retired in production")

    # -- the development overlay must actually be doing something ------------
    # Without this half, deleting the override would make the production checks
    # pass for the wrong reason -- "isolated" because nothing exists to leak.
    if re.search(r"host\.docker\.internal", local_config):
        ok("local config points the server at the host chain")
    else:
        bad("local config is missing host.docker.internal: the override is not loading")

    if re.search(r"published:\s*\"?3000\"?", local_config):
        ok("local config publishes 3000")
    else:
        bad("local config does not publish 3000")

    if "host-gateway" not in prod_config and "host-gateway" in local_config:
        ok("the two file sets genuinely differ")

    # -- the detector must be able to fail ----------------------------------
    print("\n  detector self-test (would it notice?)")
    samples = [
        ("a host gateway reference", "      RPC_URL: http://host.docker.internal:8545\n", True),
        ("a published port 3000", "        published: \"3000\"\n", True),
        ("a published port 3307", "        published: \"3307\"\n", True),
        ("a named override file", "# from docker-compose.override.yml\n", True),
        ("port 8080, which is fine", "        published: \"8080\"\n", False),
        ("an ordinary config", "      image: voting-web:dev\n", False),
    ]
    for name, sample, should_detect in samples:
        detected = bool(find_leaks(sample))
        if detected == should_detect:
            ok(f"{'flags' if should_detect else 'ignores'} {name}")
        else:
            bad(f"detector got {name} wrong (detected={detected})")

    print(f"\n{'FAILED' if failures else 'ok'}: compose isolation")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
