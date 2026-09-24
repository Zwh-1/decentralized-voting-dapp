#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Renders the Alertmanager config from a template, then execs Alertmanager.
#
# ---------------------------------------------------------------------------
# Why this exists
# ---------------------------------------------------------------------------
#
# Alertmanager does not interpolate environment variables into its config file.
# There is no way to write `smtp_auth_password: ${SMTP_PASSWORD}` and have it
# resolved, so the only alternative to this script is the SMTP password sitting
# in plaintext in a committed file. That is the whole reason for a template and a
# render step.
#
# ---------------------------------------------------------------------------
# Why envsubst is given an explicit variable list
# ---------------------------------------------------------------------------
#
# `envsubst` with no arguments replaces every `$word` it finds. Alertmanager
# configs contain Go template syntax, and those templates legitimately use
# `$labels`, `$value` and friends -- which envsubst would silently blank out,
# producing a config that loads and then sends notifications with empty fields.
# Listing the variables means only those are touched. `$` sequences that are not
# on the list survive untouched, which is what the templates need.
#
# ---------------------------------------------------------------------------
# Why the rendered file goes to /tmp and is chmod 600
# ---------------------------------------------------------------------------
#
# It contains the password. /tmp is not a secret store, but the container's
# filesystem is not shared or persisted, and the alternative -- rendering into a
# mounted volume -- would put the plaintext password on the host's disk, which is
# exactly what this script exists to avoid.

set -eu

template=/etc/alertmanager/alertmanager.yml.tmpl
rendered=/tmp/alertmanager.yml

# shellcheck disable=SC2016 # envsubst must receive the literal ${...} names, not their values
SUBST_VARS='${SMTP_SMARTHOST} ${SMTP_FROM} ${SMTP_USERNAME} ${SMTP_PASSWORD} ${ALERT_EMAIL_TO}'

# Fail before rendering rather than after: an empty password produces a config
# that starts correctly and then fails to authenticate at the moment an alert
# needs to go out, which is the worst possible time to discover it.
for name in SMTP_SMARTHOST SMTP_FROM SMTP_USERNAME SMTP_PASSWORD ALERT_EMAIL_TO; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "alertmanager: required environment variable $name is empty or unset" >&2
    exit 1
  fi
done

umask 077
envsubst "$SUBST_VARS" <"$template" >"$rendered"
chmod 600 "$rendered"

echo "alertmanager: rendered $template -> $rendered"

exec /bin/alertmanager --config.file="$rendered" "$@"
