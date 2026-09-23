# ops — deployment, monitoring, and the nginx front end

Everything the host needs that is not an application image. The application code
lives in `web/`, `contracts/`, and `mysql`'s official image; this directory is
what turns those into a running, observable deployment.

## Layout

| Path            | What it is                                                             |
| --------------- | ---------------------------------------------------------------------- |
| `deploy/`       | The scripts `deploy.sh`, `rollback.sh`, and the health gate they share |
| `nginx/`        | Front end: TLS termination and the upstream that names the active slot |
| `prometheus/`   | Scrape config, alert rules, and `check-rules.py`                       |
| `alertmanager/` | Config template and the render-and-exec entrypoint                     |
| `grafana/`      | Provisioned datasource and dashboards                                  |
| `blackbox/`     | Probe modules                                                          |
| `indexer/`      | The wrapper that turns the index loop into a supervised worker         |
| `runbook/`      | Operational procedures                                                 |
| `server/`       | One-time host preparation                                              |
| `ci/`           | Checks on the GitHub Actions workflows themselves                      |

## Bringing it up

Development, building locally, single `web` container:

```bash
docker compose up -d
```

Production, pulling an immutable image, two slots behind nginx:

```bash
export WEB_IMAGE=<registry>/voting-web
export WEB_IMAGE_TAG=sha-<12 hex>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Both `-f` flags, always, in that order.** Compose also auto-loads
`docker-compose.override.yml`; production must not depend on a file meant for
development, so each environment names its own files instead of relying on the
automatic overlay. (This repository has no such file — the point is that the
command does not rely on its absence.)

Adding observability to either:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --profile observability up -d
```

The observability services are behind a profile on purpose: the application runs
without them, and keeps running when they are stopped. Monitoring that the
monitored system depends on converts a broken dashboard into an outage.

### Why production needs `WEB_IMAGE` set

The two slots declare `image: ${WEB_IMAGE:?...}` — a _required_ variable, not one
with a default. This means a bare `docker compose config` fails until it is set:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
# error: required variable WEB_IMAGE is missing a value
```

That is deliberate. A default here would be a production deployment that silently
pulls whatever the default happened to name, and "which commit is serving" would
stop having an answer. For a syntax check, set it to anything:

```bash
WEB_IMAGE=example/voting-web \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet
```

## The active slot is the single source of truth

`/srv/voting/state/active-slot` decides which slot receives traffic. Everything
else is derived:

```
state/active-slot  ->  render-upstream.sh  ->  nginx/upstream/upstream.conf  ->  nginx -s reload
```

`ops/nginx/upstream/upstream.conf` is therefore a **generated file**. Editing it
by hand appears to work until the next deploy overwrites it — a change that
silently reverts is worse than one that fails, because the failure is deferred to
whoever is on call later. Change the state file, or run `deploy.sh`/`rollback.sh`.

## Accessing Grafana

Nothing in the observability stack is published. Grafana is reached over an SSH
tunnel:

```bash
ssh -L 3000:localhost:3000 deploy@<server>
# then open http://localhost:3000
```

The port is not mapped to the host at all, so there is no address at which the
dashboards are reachable from the internet — this is a property of the network
topology, not of a firewall rule someone could later edit.

## Host preparation

One-time, before the first deploy — see `ops/server/README.md`. It creates the
`deploy` user, the state and certificate directories, the read-only MySQL
monitoring account, and the textfile directory node-exporter reads.
