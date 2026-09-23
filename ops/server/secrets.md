# Configuration and credentials

**Names and purposes only. No values, ever.** See ADR-0016 (preflight checks
usability and never echoes a value) and ADR-0020 (failure reports give the shape,
never the environment). A credential copied into this file, or into an issue, or
into a chat window, has to be rotated — so the file is written to make that
unnecessary rather than to be convenient once.

---

## The important part: these are four different stores

The single most likely setup mistake is treating this as one list. It is not, and
the stores are not interchangeable:

| Store                     | Read by                               | If you put it in the wrong place                                                                                                                                                                 |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub **secrets**        | `secrets.NAME` in a workflow          | —                                                                                                                                                                                                |
| GitHub **variables**      | `vars.NAME` in a workflow             | A name placed in _secrets_ when the workflow reads `vars.` resolves to **empty**. The image tag becomes `/voting-web` and the build fails, or worse, succeeds and pushes to the wrong namespace. |
| Server `/srv/voting/.env` | compose, via `env_file:` and `${VAR}` | Never in GitHub. The application's database password has no business in a CI system that does not need it.                                                                                       |
| Local `.env`              | the contracts deploy, run by hand     | A private key in GitHub secrets would be readable by anything that can modify a workflow. Deployment does not run in CI here.                                                                    |

`DOCKERHUB_USERNAME` is the one that bites: it is a **variable**, not a secret. A
username is not a credential. Following a flat list of "15 secrets" and creating
it as a secret produces a build that cannot find it.

---

## 1. GitHub secrets — 5

Create at **Settings → Secrets and variables → Actions → Secrets**, and scope
them to the `production` environment where noted.

| Name              | Purpose                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCKERHUB_TOKEN` | Pushes the image to Docker Hub. An **access token**, not the account password — a password cannot be scoped or revoked independently. |
| `SSH_HOST`        | The server the deploy job reaches.                                                                                                    |
| `SSH_USER`        | `deploy`. Not root: the deploy needs the `docker` group, not `sudo`.                                                                  |
| `SSH_KEY`         | The **private** half of the ed25519 keypair. Public half lives in `/home/deploy/.ssh/authorized_keys`.                                |
| `SSH_KNOWN_HOSTS` | The server's host key, pinned.                                                                                                        |

**`SSH_KNOWN_HOSTS` must come from a trusted channel** — read the fingerprint off
the cloud console, or `ssh-keyscan` on the server itself and compare it by eye.
Scanning from the workflow would accept whatever answers, which is the same as
having no host verification at all while looking like you have it. This is why
`ssh-keyscan` is mechanically forbidden in the workflows: `ops/ci/check-workflows.py`
fails the build if it appears.

---

## 2. GitHub variables — 4

Create at **Settings → Secrets and variables → Actions → Variables**.

These are **build-time** inputs, which is why they are variables and not runtime
configuration. `NEXT_PUBLIC_*` is inlined into the JavaScript bundle by
`next build`; a container started with a different value would keep serving the
old one, because there is nothing left in the bundle that reads the environment.

| Name                          | Purpose                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCKERHUB_USERNAME`          | Namespace for the image. Referenced as `vars.` in `release.yml`.                                                                                                                                                                                                                       |
| `NEXT_PUBLIC_SEPOLIA_RPC_URL` | The RPC endpoint the **browser** uses on Sepolia. Changes require a rebuild, by design.                                                                                                                                                                                                |
| `NEXT_PUBLIC_LOCAL_RPC_URL`   | The same for a local chain. Still required in production builds even though the deployed app does not use chain 31337: leaving it empty changes the bundle, and "the bundle differs between environments" is exactly the drift that rebuilding per environment exists to make visible. |
| `NEXT_PUBLIC_IPFS_GATEWAY`    | Where poll metadata is read from.                                                                                                                                                                                                                                                      |

---

## 3. Server: `/srv/voting/.env` — mode 0600, owned by `deploy`

Read by compose for both `env_file:` and `${VAR}` interpolation. Never committed;
`ops/server/README.md` creates it.

| Name                                                            | Purpose                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RPC_URL`                                                       | Server-side RPC. **Not** the same value as `NEXT_PUBLIC_SEPOLIA_RPC_URL` — see the distinction in `docker-compose.override.yml`.                                                                                                                                      |
| `CHAIN_ID`                                                      | 11155111 for Sepolia.                                                                                                                                                                                                                                                 |
| `CONFIRMATIONS`                                                 | How far behind the head the indexer stays.                                                                                                                                                                                                                            |
| `CHUNK_BLOCKS`                                                  | Blocks per `eth_getLogs` call.                                                                                                                                                                                                                                        |
| `POLL_INTERVAL_MS`                                              | The indexer's loop interval.                                                                                                                                                                                                                                          |
| `INDEXER_ENABLED`                                               | `false` on every container. The `indexer` service is the single drainer; a second one races the same cursor.                                                                                                                                                          |
| `DATABASE_URL`                                                  | `mysql://voting:<password>@mysql:3306/voting` — the compose service name, not a hostname.                                                                                                                                                                             |
| `MYSQL_ROOT_PASSWORD`                                           | Consumed by the `mysql` image to initialise the database, and by nothing else: `docker-compose.yml` interpolates it, and every service that would otherwise receive it through `env_file:` blanks it out (the app services and Alertmanager — see the anchors below). |
| `MYSQL_DATABASE`                                                | `voting`.                                                                                                                                                                                                                                                             |
| `MYSQL_USER`                                                    | `voting`.                                                                                                                                                                                                                                                             |
| `MYSQL_PASSWORD`                                                | The application's password. Must match the one in `DATABASE_URL` — it is the same account.                                                                                                                                                                            |
| `MYSQLD_EXPORTER_PASSWORD`                                      | For the read-only `exporter` account. Deliberately a separate, narrower credential than the application's — see below.                                                                                                                                                |
| `SMTP_SMARTHOST`, `SMTP_FROM`, `SMTP_USERNAME`, `SMTP_PASSWORD` | Alertmanager's mail relay. `alertmanager.yml.tmpl` is rendered by `ops/alertmanager/entrypoint.sh`, which fails immediately if any of these is empty.                                                                                                                 |
| `ALERT_EMAIL_TO`                                                | Where alerts go.                                                                                                                                                                                                                                                      |
| `GRAFANA_ADMIN_PASSWORD`                                        | Grafana's admin login.                                                                                                                                                                                                                                                |
| `WEB_IMAGE`                                                     | `<registry>/voting-web`. Required — `docker-compose.prod.yml` uses `${WEB_IMAGE:?}`, so a missing value is a startup error rather than a silent pull of a wrong default.                                                                                              |

### `env_file:` hands the whole file to every service that names it

`.env` holds credentials belonging to four different owners. Any service that lists
it under `env_file:` receives **all** of them, so `docker-compose.yml` defines two
scrub anchors that blank what each service has no use for:

| Anchor                     | Services                                      | Keeps                                                      | Blanks                                            |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| `x-app-env-scrub`          | `web-blue`, `web-green`, `migrate`, `indexer` | `MYSQL_PASSWORD` (they connect with it)                    | root, exporter, Grafana and SMTP passwords        |
| `x-alertmanager-env-scrub` | `alertmanager`                                | the five `SMTP_*` values (its entrypoint substitutes them) | root, application, exporter and Grafana passwords |

`environment:` takes precedence over `env_file:` key by key, so an empty string
there is a removal, not a second copy of a value.

Verified against a rendered `docker compose config --profile observability` with
every field filled in `.env`: Alertmanager's environment has
`MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD`, `MYSQLD_EXPORTER_PASSWORD` and
`GRAFANA_ADMIN_PASSWORD` empty, while `SMTP_SMARTHOST`, `SMTP_FROM` and
`SMTP_PASSWORD` arrive intact.

### The MySQL exporter account is deliberately narrower

`mysqld-exporter` gets `PROCESS`, `REPLICATION CLIENT`, and `SELECT` on
`performance_schema` — not the application's credentials. A compromised dashboard
should not be able to read or write votes. The SQL is in
`ops/server/README.md`.

There is also **no `.my.cnf`**: the password reaches the exporter through the
environment and nothing is written to disk. One fewer file for a credential to
leak out of, and one fewer file to forget to `chmod`.

---

## 4. Local `.env` — the contracts deploy, run by hand

| Name                  | Purpose                                |
| --------------------- | -------------------------------------- |
| `SEPOLIA_RPC_URL`     | RPC used by the Hardhat deploy script. |
| `SEPOLIA_PRIVATE_KEY` | The deployer key.                      |

This deliberately does **not** live in GitHub secrets. The factory deployment is a
deliberate, occasional, reviewed action, not something that should run on every
push or be reachable by editing a workflow file. A key that CI can read is a key
that anyone who can open a pull request can exfiltrate.

---

## Verifying the setup

```bash
# Names present, values never printed.
gh secret list --env production
gh variable list

# The environment exists and requires review.
gh api repos/:owner/:repo/environments --jq '.environments[] | {name, reviewers: (.protection_rules | length)}'

# The pinned host key matches what the server reports.
ssh-keyscan -t ed25519 "$SSH_HOST" 2>/dev/null | ssh-keygen -lf -
# Compare that fingerprint against the cloud console. Do not pipe it into a file.

# Nothing in the repository looks like a credential.
grep -rnE '(BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]\s*[^ $])' --include='*.yml' --include='*.md' . | grep -v 'secrets.md'
# Expect: no output.
```
