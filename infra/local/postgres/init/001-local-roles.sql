-- The official Postgres entrypoint creates POSTGRES_USER as the database owner.
-- Keep that one role as the only local login and remove its bootstrap superuser
-- capabilities before the application starts.
ALTER ROLE tianxing_app WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE tianxing TO tianxing_app;
