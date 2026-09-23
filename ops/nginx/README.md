# nginx

The front end. Terminates TLS and proxies to the active slot.

## The one rule

**`upstream/upstream.conf` is generated. Do not edit it.**

```
/srv/voting/state/active-slot          <- the single source of truth
        |
        v
ops/nginx/render-upstream.sh           <- renders and reloads
        |
        v
/srv/voting/nginx/upstream/upstream.conf   <- generated, mounted read-only
        |
        v
nginx -s reload
```

An edit to the generated file appears to work and then disappears at the next
deploy. A change that silently reverts is worse than one that fails, because the
failure surfaces later, in a different context, to someone who did not make it.

To change which slot serves traffic, change the state file _and_ re-render:

```bash
# Do not do this by hand during normal operation -- deploy.sh and rollback.sh do
# it. This is the manual recovery path.
echo green > /srv/voting/state/active-slot
./ops/nginx/render-upstream.sh
```

## The first render, before nginx has ever started

`nginx.conf` includes the upstream by **exact path** (`include
/etc/nginx/upstream/upstream.conf;`), and nginx treats a missing include target as
a startup failure. So:

- nginx cannot start until the upstream file exists;
- the upstream file is written by `render-upstream.sh`.

For the render to be runnable first, it validates the rendered file in a
**throwaway container**
(`docker compose run --rm --no-deps nginx sh -c '… nginx -t'`) rather than by
`exec`ing into the running one. That is not a style choice: with `exec`, the
first `deploy.sh` on a fresh host failed at the switch step -- every time --
because there was no running nginx to exec into, and there could not be one. The
reload is skipped, with a line saying so, when nothing is running yet; nginx reads
the file when it starts.

That throwaway container gets one addition: `127.0.0.1 web-blue web-green` in its
own `/etc/hosts`. `nginx -t` resolves the names in the `upstream` block while
parsing it, and on a host that has never started there is no container called
`web-blue` for Docker's DNS to answer with — so the first render failed with
`[emerg] host not found in upstream "web-blue:3000"`, which is true, about DNS,
and not about the file that was just rendered. Only the two real slot names are
stubbed, so a typo in the rendered file still fails the check, and the file being
read is still the real one from the real mount path. Whether the slot actually
answers is the health gate's and the observation window's job.

When the check does reject a config, the script now prints what nginx said before
its own summary. Both failures seen so far came from a real first render — a
`log_format` declared after the `access_log` that names it, and the unresolvable
upstream above — and they need opposite fixes, so "nginx rejected the rendered
upstream" on its own is not enough to act on.

Bootstrap order on a new host (full sequence in `ops/server/README.md`):

```bash
./ops/nginx/render-upstream.sh blue    # works with nothing running
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
./ops/deploy/deploy.sh <tag>           # from here on, the normal path
```

## Why only one upstream server

The obvious alternative is to list both slots and let nginx balance between them.
That cannot express the rule this design depends on: **traffic moves only after
the target has passed its own health check.** Passive balancing has no notion of
readiness — it would start sending live requests to the new slot the moment the
container started, which is exactly the window that produces 5xx during a deploy.

Rewriting the file and reloading makes the health gate the thing that decides.
The cost is that a switch is an explicit step rather than an automatic reaction;
the benefit is that the deploy cannot move traffic to a version that has not
proven itself.

## Why `reload` and never `restart`

`nginx -s reload` starts new workers with the new configuration and asks the old
ones to exit _after_ they finish the requests they have already accepted. Nothing
in flight is dropped.

`restart` (or `stop` + `start`) closes every connection immediately, including
requests nginx has already read. Any deploy that used it would drop requests by
construction, which is why the deploy scripts only ever call `reload`.

`render-upstream.sh` also runs `nginx -t` **before** reloading, and restores the
previous file if the new configuration is rejected. A reload with a bad config
leaves nginx running the old config while the deploy reports success — so the
deploy appears to work and the old version keeps serving.

## `/api/metrics` is refused, explicitly

```nginx
location = /api/metrics { return 403; }
```

This is not belt-and-braces. This proxy forwards everything under `/` to the
application, so without the rule the metrics endpoint would be reachable from the
internet by default. Prometheus reads it over the internal network instead, so
refusing it here costs nothing and closes a real exposure.

The `=` makes it an exact match, so it wins over the `/api/` prefix location
regardless of ordering.

## A certificate must exist before nginx starts

nginx reads its certificate files at startup and refuses to run if they are
missing. That makes TLS a prerequisite of the whole stack rather than a later
refinement. `ops/server/README.md` has the commands, including the self-signed
pair for the case where there is no domain yet.

The HTTP server block exists only to redirect, with one exception:
`/.well-known/acme-challenge/` is served before the redirect so that certificate
renewal keeps working. Without it the redirect would also bounce the CA's
validation request, and the failure would appear months later at expiry.

## Verifying a change

```bash
# Syntax, inside the running container:
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec nginx nginx -t

# The endpoint that must not be public:
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/metrics   # 403

# The endpoint that must be:
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/health    # 200
```
