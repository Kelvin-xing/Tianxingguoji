import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "pg";
import { verifyOrderedMigrationManifest } from "./migration-manifest.ts";

const NAME = "202611150010_076_expand_school_directory_structure.sql";
const TABLES = ["schools_directory_schools", "schools_directory_campuses",
  "schools_directory_field_modes", "schools_directory_history"] as const;

/** Explicit local-only extension of the frozen bootstrap. Never run by build. */
export async function runSchoolDirectoryLocal(
  mode: "dry-run" | "apply" | "rollback",
  connectionString = process.env.ONE_ROLE_BASELINE_DATABASE_URL,
) {
  if (!connectionString) throw new Error("Local baseline database configuration required");
  const u = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.pathname !== "/tianxing"
    || decodeURIComponent(u.username) !== "tianxing_app") {
    throw new Error("School directory migration rejects non-local targets");
  }
  const manifest = await verifyOrderedMigrationManifest();
  if (manifest.migrations.at(-1)?.name !== NAME) throw new Error("Directory migration must be the verified last migration");
  const [up, down] = (await readFile(new URL(`../../db/migrations/${NAME}`, import.meta.url), "utf8")).split("-- migrate:down");
  const client = new Client({ connectionString, application_name: "school-directory-local-structure",
    statement_timeout: 10_000, lock_timeout: 5_000 });
  await client.connect();
  try {
    const info = (await client.query(`SELECT current_database() db,current_user actor,
      current_setting('server_version_num')::int version`)).rows[0];
    if (info.db !== "tianxing" || info.actor !== "tianxing_app" || info.version < 170000 || info.version >= 180000) {
      throw new Error("Local PostgreSQL 17 identity rejected");
    }
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(681115)");
    const exists = (await client.query("SELECT to_regclass('public.schools_directory_schools') IS NOT NULL present")).rows[0].present;
    if (mode === "rollback") {
      if (!exists) throw new Error("Directory migration is not installed");
      // All locks acquired before owner-only emptiness inspection. FORCE is restored
      // on any error by transaction rollback; no grant/policy is added at any point.
      await client.query(`LOCK TABLE ${TABLES.join(",")} IN ACCESS EXCLUSIVE MODE`);
      for (const table of TABLES) {
        await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
        if ((await client.query(`SELECT EXISTS(SELECT FROM ${table}) occupied`)).rows[0].occupied) {
          throw new Error("Rollback refused: directory data or history exists");
        }
      }
      await client.query(down!);
    } else {
      if (exists) throw new Error("Directory migration already installed; refusing replay");
      await client.query(up!);
      for (const table of TABLES) {
        const r = (await client.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass", [table])).rows[0];
        if (!r?.relrowsecurity || !r.relforcerowsecurity) throw new Error("Directory RLS postflight failed");
      }
    }
    await client.query(mode === "dry-run" ? "ROLLBACK" : "COMMIT");
    const after = (await client.query("SELECT to_regclass('public.schools_directory_schools') IS NOT NULL present")).rows[0].present;
    if (after !== (mode === "apply")) throw new Error("Directory postflight failed");
    return { mode, status: "pass", database: "local-tianxing", migration: NAME,
      manifestSha256: manifest.manifestSha256, structure: after ? "empty-installed" : "absent" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--dry-run";
  if (!["--dry-run", "--apply", "--rollback"].includes(mode)) throw new Error("Use --dry-run, --apply or --rollback");
  try { console.log(JSON.stringify(await runSchoolDirectoryLocal(mode.slice(2) as "dry-run" | "apply" | "rollback"))); }
  catch { console.error("School directory local migration failed; no connection details logged"); process.exitCode = 1; }
}
