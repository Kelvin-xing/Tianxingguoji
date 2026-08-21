#!/bin/sh
set -eu

password_file="${POSTGRES_PASSWORD_FILE:-/run/secrets/local_postgres_password}"
if [ ! -s "$password_file" ]; then
  echo "Local PostgreSQL application password is unavailable." >&2
  exit 1
fi

app_password="$(cat "$password_file")"
if [ -z "$app_password" ]; then
  echo "Local PostgreSQL application password is empty." >&2
  exit 1
fi

export TIANXING_APP_BOOTSTRAP_PASSWORD="$app_password"
unset app_password

psql \
  --set=ON_ERROR_STOP=1 \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --no-psqlrc <<'SQL'
\getenv app_password TIANXING_APP_BOOTSTRAP_PASSWORD

CREATE ROLE tianxing_app WITH
  LOGIN
  PASSWORD :'app_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;

ALTER DATABASE tianxing OWNER TO tianxing_app;
REVOKE ALL ON DATABASE tianxing FROM PUBLIC;
GRANT CONNECT ON DATABASE tianxing TO tianxing_app;

-- Keep the image bootstrap superuser for ownership recovery, but make it
-- unusable as an application or operator login after initialization.
ALTER ROLE postgres NOLOGIN;
SQL

unset TIANXING_APP_BOOTSTRAP_PASSWORD
