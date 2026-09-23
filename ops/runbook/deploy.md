# Deploy runbook

Procedures for the things that happen under pressure. Each one is written to be
followed by someone who did not build this and is not currently calm.

## Contents

- [Which release is serving](#which-release-is-serving)
- [A deploy failed](#a-deploy-failed)
- [Rolling back](#rolling-back)
- [The site is down](#the-site-is-down)
- [Zero-downtime drill](#zero-downtime-drill)
- [Schema migrations](#schema-migrations)

---

## Which release is serving

Three questions, in the order they become useful.

```bash
# 1. What does the deploy system think?
ssh deploy@<server> 'cd /srv/voting && cat state/active-slot state/active-tag state/previous-tag'

# 2. What does nginx think? (The generated upstream is derived from (1).)
ssh deploy@<server> 'cat /srv/voting/nginx/upstream/upstream.conf'

# 3. What is actually running?
ssh deploy@<server> 'cd /srv/voting && docker compose -f docker-compose.yml -f docker-compose.prod.yml ps'
```

If (1) and (2) disagree, the state file was changed without a reload — run
`ops/nginx/render-upstream.sh` to re-derive the upstream, then reload.

If (2) and (3) disagree, the named slot is not running. Requests are going to a
container that does not exist, which shows up as 502. Start it:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps web-<slot>
```

**Both slots run at all times.** Seeing two `web-*` containers is correct, not a
leak. The idle one is the rollback target.

---

## A deploy failed

`deploy.sh` stops at the first failed stage. What it leaves behind differs by
stage, and the difference matters:

| Failed at | State                                                        | What to do                                        |
| --------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `pull`    | Nothing changed                                              | Fix the tag or the registry credentials, redeploy |
| `migrate` | Nothing changed; the old version is still serving            | Fix the migration, redeploy                       |
| `start`   | The target slot did not start; traffic never moved           | Read `docker compose logs web-<target>`           |
| `health`  | The target slot was **stopped**; traffic never moved         | Investigate, then redeploy                        |
| `switch`  | The target slot was stopped; traffic never moved             | Check `nginx -t` output                           |
| `observe` | Traffic was returned to the old slot and the new one stopped | The new version is broken under real traffic      |

Every abort appends a line to `state/deploy.log`. The deploy never leaves traffic
pointing at a slot it has not health-checked — so after any failure the site is
serving the previous release, and **there is no emergency**. Diagnosis can take as
long as it needs.

```bash
ssh deploy@<server> 'cd /srv/voting && tail -30 state/deploy.log'
```

---

## Rolling back

```bash
ssh deploy@<server> 'cd /srv/voting && ./ops/deploy/rollback.sh'
```

With no argument it returns to `previous-tag`. Give a tag to go somewhere else.

**Why it is fast.** The previous slot is still running, so a rollback rewrites the
upstream file and reloads nginx. No image pull, no container start, no warm-up.
This is the whole reason the old slot is not stopped after a deploy.

**It does not roll back the schema.** Migrations are written to be backward
compatible so the previous release runs against the current schema. If a
migration was ever written that is not backward compatible, that release is **not
rollbackable** and must be fixed forward. See [Schema migrations](#schema-migrations).

Verify:

```bash
ssh deploy@<server> 'cd /srv/voting && cat state/active-slot state/active-tag'
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/health    # 200
```

---

## The site is down

Work from the outside in. Each step rules out one layer, and stopping at the
first step that looks fine is how an hour gets spent in the wrong layer.

```bash
# 1. Is the public endpoint answering at all?
curl -sS -o /dev/null -w 'code=%{http_code} time=%{time_total}\n' https://<domain>/api/health

# 2. Is nginx running and does it accept its config?
docker compose ... exec nginx nginx -t
docker compose ... logs --tail 50 nginx

# 3. Is the active slot up?
docker compose ... ps
docker compose ... logs --tail 50 web-<active-slot>

# 4. Is the database reachable from the app?
docker compose ... exec web-<active-slot> node -e \
  'fetch("http://localhost:3000/api/health").then(r=>r.text()).then(console.log)'

# 5. Is the disk full? (Predictable, and it takes everything down at once.)
df -h /srv
```

Common causes, in the order they actually occur:

- **Disk full** — MySQL stops first, then the containers that need to write. The
  `HostDiskWillFillIn4Hours` alert fires before this; if it was ignored, that is
  the finding.
- **The active slot died** — `ContainerDown` fires. Start it, or roll back.
- **A bad migration** — the app starts and then errors on every query. Confirm
  with the app logs; recovery is a forward fix, not a rollback.
- **The disk filled with container logs** — production sets `max-size: 10m` and
  `max-file: 3` on every service. A container missing those options is a bug.

---

## Zero-downtime drill

The claim is that a deploy drops no requests. It has to be measured in requests,
because "the site was up afterwards" is also consistent with a two-second outage
nobody happened to see.

**Experimental group — dual slot:**

```bash
# On a machine that can reach the site:
./ops/deploy/probe-loop.sh https://<domain>/api/health 120 2 &
# Then, on the server, run a deploy:
ssh deploy@<server> 'cd /srv/voting && ./ops/deploy/deploy.sh <newtag>'
wait
```

Expect `{"failed":0,"maxConsecutiveFailures":0}`.

**Control group — update in place:**

```bash
./ops/deploy/probe-loop.sh https://<domain>/api/health 120 2 &
ssh deploy@<server> 'cd /srv/voting && docker compose ... up -d --force-recreate web-<active>'
wait
```

Expect `failed > 0`: recreating the serving container stops it before the
replacement is ready.

**The control group is not optional.** If it also reports zero failures, the probe
is too coarse to see the outage — shorten the interval and repeat until it can.
An experimental result of "0 failures" means nothing unless the same instrument
can detect a failure that is known to be there. Record both JSON lines side by
side; the comparison is the evidence.

---

## Schema migrations

The full constraint is in [migrations.md](migrations.md). The operational summary:

**Allowed in one release:** new tables, new nullable columns or columns with
defaults, new indexes, new views.

**Forbidden in one release:** dropping or renaming a column or view the old
version still uses, adding `NOT NULL` to an existing column without a default.

**Why:** during a deploy both versions run against one database. The old version
must keep working against the new schema, and the new version must work against
the schema the old version expects.

**Destructive changes take two releases.** Release N adds the new structure and
backfills, leaving the old one in place. Release N+1 removes the old structure,
after confirming no old version is running.

**Before deploying, check whether the release touches the schema:**

```bash
git log --oneline <previous-tag>..<new-tag> -- web/src/lib/db/schema.ts
```

Non-empty output means the release needs the two-step treatment. This is a
one-line check that prevents the most damaging mistake in the whole design, so it
belongs in the deploy checklist rather than in anyone's memory.
