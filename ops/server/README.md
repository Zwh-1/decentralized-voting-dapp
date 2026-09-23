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
umask 077
sudo -u deploy tee /srv/voting/.env >/dev/null <<'EOF'
# -- application -------------------------------------------------------------
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
CHAIN_ID=11155111
CONFIRMATIONS=5
CHUNK_BLOCKS=2000
POLL_INTERVAL_MS=4000
INDEXER_ENABLED=false
LOG_LEVEL=info
DATABASE_URL=mysql://voting:<password>@mysql:3306/voting

# -- database ----------------------------------------------------------------
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
# Self-signed (replace the CN with the domain or IP):
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /srv/voting/certs/privkey.pem \
  -out /srv/voting/certs/fullchain.pem \
  -subj "/CN=<domain-or-ip>"
sudo chown deploy:deploy /srv/voting/certs/*.pem
sudo chmod 0600 /srv/voting/certs/privkey.pem

# With a domain, certbot instead:
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
# Only SSH and HTTP(S). Everything else -- MySQL, Prometheus, Grafana -- is
# reachable solely over the compose network, and Grafana is reached through an
# SSH tunnel. The network topology already enforces this; these rules are the
# second layer, for the host itself.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
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

## The first deploy

```bash
# From the CI machine, or by hand for the first run:
rsync -az ops/ deploy@<server>:/srv/voting/ops/
# The compose files and the image tag:
rsync -az docker-compose.yml docker-compose.prod.yml deploy@<server>:/srv/voting/

ssh deploy@<server> 'cd /srv/voting && \
  WEB_IMAGE=<registry>/voting-web WEB_IMAGE_TAG=sha-<12hex> ./ops/deploy/deploy.sh sha-<12hex>'
```

`deploy.sh` initialises `active-slot` to `blue` on a host that has never been
deployed to, so the first run needs no special handling.
