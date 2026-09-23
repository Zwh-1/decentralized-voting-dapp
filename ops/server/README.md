# Host preparation

One-time setup on a fresh server, before the first deploy. Run as a user with
`sudo`. Every step says what it is for, because a step nobody understands is a
step that gets skipped during the next rebuild.

Assumptions: Debian or Ubuntu. Adjust package names for other distributions.

```bash
# ---------------------------------------------------------------------------
# 1. Docker Engine and the compose plugin
# ---------------------------------------------------------------------------
# Use Docker's own repository rather than the distribution's package. The
# distribution version is often several releases behind, and the `docker compose`
# plugin in particular is missing from older packages -- which would make every
# command in this repository fail with a confusing "unknown command" error.
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# ---------------------------------------------------------------------------
# 2. gettext-base -- for envsubst
# ---------------------------------------------------------------------------
# Needed on the *host*, not in a container: ops/nginx/render-upstream.sh uses
# envsubst to render the nginx upstream from the active slot. Without it the
# failure happens midway through a deploy, after the target slot has started but
# before traffic moves -- so the deploy aborts having changed state. The script
# checks for this up front; installing it here means the check never fires.
sudo apt-get install -y gettext-base rsync curl

# ---------------------------------------------------------------------------
# 3. The deploy user
# ---------------------------------------------------------------------------
# The CI job SSHes in as this user. It owns the state directory and is in the
# docker group; it does not need sudo, and should not have it.
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy

# The CI runner's public key. This is the only credential that can reach the host.
sudo install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
sudo tee /home/deploy/.ssh/authorized_keys >/dev/null <<'KEY'
<the public half of the deploy key>
KEY
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 0600 /home/deploy/.ssh/authorized_keys

# ---------------------------------------------------------------------------
# 4. Directory layout
# ---------------------------------------------------------------------------
# /srv/voting is the working directory: compose files, ops/, .env, and state/.
export WEB_IMAGE=<registry>/voting-web
sudo install -d -o deploy -g deploy /srv/voting
sudo install -d -o deploy -g deploy /srv/voting/state
sudo install -d -o deploy -g deploy /srv/voting/state/textfile
sudo install -d -o deploy -g deploy /srv/voting/nginx /srv/voting/nginx/upstream
sudo install -d -o deploy -g deploy /srv/voting/certs
sudo install -d -o deploy -g deploy /var/www/certbot

# node-exporter reads the textfile directory as an unprivileged user inside its
# container, so the files must be world-readable. publish-version.sh writes them
# 0644 for exactly this reason.
chmod 0755 /srv/voting/state /srv/voting/state/textfile

# ---------------------------------------------------------------------------
# 5. The application environment file
# ---------------------------------------------------------------------------
# Lives at /srv/voting/.env, mode 0600, owned by deploy. Never in git, never in
# an image. compose reads it for both `env_file:` and `${VAR}` interpolation.
#
# RPC_URL and CHAIN_ID must be present: docker-compose.prod.yml spells them
# `${RPC_URL:?}` / `${CHAIN_ID:?}`, so compose refuses to render anything at all
# without them. That is deliberate -- the alternative is a slot that quietly
# falls back to 127.0.0.1:8545 on chain 31337, serves a page with zero polls, and
# still answers /api/health with 200, which is a green deploy of nothing.
#
# There is no LOG_LEVEL: nothing reads it. `deploy-env/server.env` is the
# authoritative list of what this file may contain.
umask 077
sudo -u deploy tee /srv/voting/.env >/dev/null <<'EOF'
# -- application -------------------------------------------------------------
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
CHAIN_ID=11155111
CONFIRMATIONS=5
CHUNK_BLOCKS=2000
POLL_INTERVAL_MS=4000
INDEXER_ENABLED=false
DATABASE_URL=mysql://voting:<password>@mysql:3306/voting

# -- database ----------------------------------------------------------------
# Interpolated by docker-compose.yml into the mysql service. The app containers
# get these blanked out again, so the root password stays in one place.
# MYSQL_USER / MYSQL_PASSWORD must be the same account named in DATABASE_URL.
MYSQL_ROOT_PASSWORD=<password>
MYSQL_DATABASE=voting
MYSQL_USER=voting
MYSQL_PASSWORD=<password>
MYSQLD_EXPORTER_PASSWORD=<password for the exporter account>

# -- alerting ----------------------------------------------------------------
SMTP_SMARTHOST=smtp.example.com:587
SMTP_FROM=voting-alerts@example.com
SMTP_USERNAME=<username>
SMTP_PASSWORD=<password>
ALERT_EMAIL_TO=oncall@example.com

# -- dashboards --------------------------------------------------------------
GRAFANA_ADMIN_PASSWORD=<password>

# -- deploy ------------------------------------------------------------------
WEB_IMAGE=<registry>/voting-web
EOF
sudo chmod 0600 /srv/voting/.env

# ---------------------------------------------------------------------------
# 6. A TLS certificate
# ---------------------------------------------------------------------------
# nginx will not start without one -- it reads the files at startup and refuses to
# run if they are missing. With a domain, use certbot. Without one, a self-signed
# pair is enough to bring the stack up and smoke-test it.
#
# Self-signed, reached by IP. The `subjectAltName` is not optional: for an IP
# address, browsers and curl ignore the CN entirely and check the SAN. A CN-only
# certificate is rejected by every client even after it is trusted, which looks
# like "the certificate does not work" rather than "the SAN is missing".
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /srv/voting/certs/privkey.pem \
  -out /srv/voting/certs/fullchain.pem \
  -subj "/CN=106.14.239.194" \
  -addext "subjectAltName=IP:106.14.239.194"
sudo chown deploy:deploy /srv/voting/certs/*.pem
sudo chmod 0600 /srv/voting/certs/privkey.pem

# A self-signed certificate is enough to bring the stack up and smoke-test it; it
# is not enough to put in front of users, because every browser warns. Two probes
# have to be told about it, or they fail forever against a certificate nothing
# trusts -- see "The public probe target" and "The observation window" below.
#
# With a domain, certbot instead (and then remove both exceptions above):
# sudo apt-get install -y certbot
# sudo certbot certonly --webroot -w /var/www/certbot -d <domain>
# then symlink /etc/letsencrypt/live/<domain>/fullchain.pem and privkey.pem into
# /srv/voting/certs/. Renewal needs the `/.well-known/acme-challenge/` location,
# which the shipped nginx config already provides.

# ---------------------------------------------------------------------------
# 7. The MySQL monitoring account
# ---------------------------------------------------------------------------
# A separate read-only account, not the application's. The exporter needs to read
# server status; it has no reason to read the application's tables, and giving it
# the application credentials would mean a compromised dashboard leaks the ability
# to write votes.
#
# Run this after the first `docker compose up` has created the database:
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T mysql \
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<'SQL'
CREATE USER IF NOT EXISTS 'exporter'@'%' IDENTIFIED BY '<MYSQLD_EXPORTER_PASSWORD>';
GRANT PROCESS, REPLICATION CLIENT, SELECT ON *.* TO 'exporter'@'%';
FLUSH PRIVILEGES;
SQL

# ---------------------------------------------------------------------------
# 8. Firewall
# ---------------------------------------------------------------------------
# Only SSH and the published HTTPS port. Everything else -- MySQL, Prometheus,
# Grafana -- is reachable solely over the compose network, and Grafana is reached
# through an SSH tunnel. The network topology already enforces this; these rules
# are the second layer, for the host itself.
#
# 8443, not 443: `docker-compose.prod.yml` publishes `8443:443` so that a host
# already serving something else from 80/443 can run this stack alongside it.
# Change both places together if that ever stops being true.
sudo ufw allow OpenSSH
sudo ufw allow 8443/tcp
sudo ufw --force enable

# A cloud host has a second firewall in front of this one, and ufw does not touch
# it: on Aliyun that is the instance's security group, on AWS the security group,
# on GCP the VPC firewall rule. Opening 8443 here has no effect until it is also
# allowed there -- and the symptom is a connection that times out rather than a
# refusal, which reads like the application is down.
```

## Verifying the preparation

```bash
# The deploy user can run docker without sudo.
sudo -u deploy docker ps

# envsubst is present (render-upstream.sh checks this, but confirm now).
command -v envsubst

# The state directory is writable by the deploy user.
sudo -u deploy touch /srv/voting/state/textfile/.probe && \
  sudo -u deploy rm /srv/voting/state/textfile/.probe

# nginx can read the certificate.
sudo head -1 /srv/voting/certs/fullchain.pem
```

## The public probe target

`blackbox-external` answers a different question from `blackbox-internal`: not "is
the application serving" but "can a user reach it". It reads its target from
`ops/prometheus/targets/external.json`. An empty file is a valid state — "nothing to
probe from outside" — and it is filled in by hand rather than generated, because a
probe of a hostname that does not exist yet alerts forever, and an alert nobody can
clear is one people learn to ignore.

This deployment is reached at `https://106.14.239.194:8443/api/health`, which is what
the file now contains. Use the **public** URL a user would open, not a container
address — `blackbox-internal` already covers `http://web:3000/api/health`. The port
is `8443` because `docker-compose.prod.yml` publishes `8443:443`: this host already
serves another project from nginx on 80/443, so this stack does not claim those. The
label matches the internal job's, so the two views can be told apart by `scope` even
though the alert rule (`probe_success == 0`) covers both.

Two things about it are easy to get wrong:

- The job uses the `http_2xx_insecure` module, because the certificate is
  self-signed and verification could only ever fail. It proves reachability and
  nothing about identity. Switch it to `http_2xx` in `ops/prometheus/prometheus.yml`
  in the same change that installs a certificate something trusts, and not before.
- `blackbox-exporter` is on the `egress` network as well as `backend`. `backend` is
  `internal: true`, so a container on it alone has no route to a public address and
  this probe could not succeed at all — it would be a permanent critical alert.

Prometheus re-reads `file_sd` files on an interval (5 minutes by default) and its
reload endpoint is not enabled here, so either wait or pick the file up at once:

```bash
cd /srv/voting && docker compose -f docker-compose.yml -f docker-compose.prod.yml restart prometheus
```

## The observation window and a certificate nothing trusts

`deploy.sh` observes the **public** URL after moving traffic, and treats a failure
there as a failed release: it moves the upstream back and stops the new slot. That
makes `PUBLIC_HEALTH_URL` a hard requirement, and with a self-signed certificate
there is a second one:

```bash
cd /srv/voting
PUBLIC_HEALTH_URL=https://106.14.239.194:8443/api/health \
  INSECURE_TLS=1 \
  WEB_IMAGE=<registry>/voting-web ./ops/deploy/deploy.sh <tag>
```

Without `INSECURE_TLS=1`, curl refuses the certificate, every request in the window
fails, and the deploy rolls back a release that was working — after traffic has
already moved, which is the worst moment to be told something untrue. The same
variable is what the `http_2xx_insecure` module does for the external scrape, and
it is recorded in the probe summary as `"insecureTls":true` so a weakened
measurement cannot be mistaken for a normal one.

Drop `INSECURE_TLS=1` in the same change that installs a trusted certificate.

```bash
# The window by itself, if it needs to be run separately:
INSECURE_TLS=1 ./ops/deploy/probe-loop.sh https://106.14.239.194:8443/api/health 30 2
```

## The first deploy

```bash
# From the CI machine, or by hand for the first run:
# (ops/handoff/upload-to-server.sh does this, including docker-compose.external-db.yml)
rsync -az ops/ deploy@<server>:/srv/voting/ops/
# The compose files:
rsync -az docker-compose.yml docker-compose.prod.yml deploy@<server>:/srv/voting/

# 1. Render the upstream BEFORE the stack's first start. nginx.conf includes
#    /etc/nginx/upstream/upstream.conf by exact path, so nginx refuses to start
#    until that file exists -- and this script is what writes it. It validates in
#    a throwaway container, so it needs nothing running:
ssh deploy@<server> 'cd /srv/voting && ./ops/nginx/render-upstream.sh blue'

# 2. First start. Both slots come up on the tag in .env; nginx now has a config.
ssh deploy@<server> 'cd /srv/voting && \
  WEB_IMAGE=<registry>/voting-web WEB_IMAGE_TAG=sha-<12hex> \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d'

# 3. Every release from here on goes through the deploy script, which owns the
#    order: pull -> migrate -> start target slot -> health gate -> switch -> observe.
ssh deploy@<server> 'cd /srv/voting && \
  WEB_IMAGE=<registry>/voting-web ./ops/deploy/deploy.sh sha-<12hex>'
```

`deploy.sh` initialises `active-slot` to `blue` on a host that has never been
deployed to, so step 1 renders the same slot the first deploy will treat as
active, and step 3 moves traffic to `green`.

**The image is never built on the server.** There is no `build:` key in any
compose file and the uploaded tree carries no application source, so
`docker compose build` there builds nothing and says so
(`No services to build`). The image comes from the registry (CI pushes
`sha-<12hex>`), or from a full checkout on another machine:

```bash
docker build -f web/Dockerfile -t <registry>/voting-web:sha-<12hex> .
docker push <registry>/voting-web:sha-<12hex>
```

**Watch out for `PUBLIC_HEALTH_URL`.** `deploy.sh`'s observation window probes
`https://localhost/api/health` by default, and that name is not in any
certificate you will issue for a real domain -- so the probe fails TLS
verification and the deploy reports failure after having already switched
traffic. Pass the public URL explicitly, in the same environment (it is read from
the shell, **not** from `.env`):

```bash
PUBLIC_HEALTH_URL=https://<domain>/api/health \
  WEB_IMAGE=<registry>/voting-web ./ops/deploy/deploy.sh <tag>
```
