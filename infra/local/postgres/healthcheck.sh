#!/bin/sh
set -eu

password_file="${POSTGRES_PASSWORD_FILE:-/run/secrets/local_postgres_password}"
if [ ! -s "$password_file" ]; then
  exit 1
fi

PGPASSWORD="$(cat "$password_file")"
export PGPASSWORD

contract="$({
  psql \
    --host=127.0.0.1 \
    --username=tianxing_app \
    --dbname=tianxing \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align <<'SQL'
SELECT 'ready'
WHERE current_database() = 'tianxing'
  AND current_user = 'tianxing_app'
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS application_role
    WHERE application_role.rolname = 'tianxing_app'
      AND application_role.rolcanlogin
      AND NOT application_role.rolsuper
      AND NOT application_role.rolcreatedb
      AND NOT application_role.rolcreaterole
      AND NOT application_role.rolinherit
      AND NOT application_role.rolreplication
      AND NOT application_role.rolbypassrls
  )
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS application_database
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = application_database.datdba
    WHERE application_database.datname = 'tianxing'
      AND owner_role.rolname = 'tianxing_app'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS bootstrap_role
    WHERE bootstrap_role.rolname = 'postgres'
      AND bootstrap_role.rolsuper
      AND NOT bootstrap_role.rolcanlogin
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'tianxing_app'
  )
  AND (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolcanlogin) = 1;
SQL
} 2>/dev/null)"

unset PGPASSWORD
[ "$contract" = "ready" ]
