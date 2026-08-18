DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
    CREATE ROLE rds_iam NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tianxing_health') THEN
    CREATE ROLE tianxing_health
      LOGIN
      PASSWORD 'tianxing-local-health-only'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tianxing_local_identity') THEN
    CREATE ROLE tianxing_local_identity
      LOGIN
      PASSWORD 'tianxing-local-identity-only'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END;
$$;

GRANT CONNECT ON DATABASE tianxing TO tianxing_health;
GRANT CONNECT ON DATABASE tianxing TO tianxing_local_identity;
