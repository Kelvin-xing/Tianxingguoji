import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Client } from "pg";

import {
  LOCAL_TRIAL_DEMO_FOUNDER,
  LOCAL_TRIAL_DEMO_ORGANIZATION,
  LOCAL_TRIAL_DEMO_PRINCIPALS,
} from "../../modules/identity/infrastructure/local-trial-demo-principals.ts";
import { loadLocalSyntheticConfig } from "../../lib/runtime/local-synthetic-config.ts";
import { readLocalRelease1SeedTarget } from "./seed-local-release1.ts";

const MANIFEST_ID = "51000000-0000-4000-8000-000000000901";
const DEMO_CASES = Object.freeze([
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000401",
    number: "LOCAL-TRIAL-INTERNATIONAL",
    studentId: "51000000-0000-4000-8000-000000000601",
    category: "international_school" as const,
    ownerLoginRole: "l2_international" as const,
    assignmentId: "51000000-0000-4000-8000-000000000421",
    transitionFactId: "51000000-0000-4000-8000-000000000441",
    taskId: "51000000-0000-4000-8000-000000000431",
    title: "国际学校申请资料准备",
  }),
  Object.freeze({
    id: "51000000-0000-4000-8000-000000000402",
    number: "LOCAL-TRIAL-LOCAL",
    studentId: "51000000-0000-4000-8000-000000000602",
    category: "local_school" as const,
    ownerLoginRole: "l2_local" as const,
    assignmentId: "51000000-0000-4000-8000-000000000422",
    transitionFactId: "51000000-0000-4000-8000-000000000442",
    taskId: "51000000-0000-4000-8000-000000000432",
    title: "本地学校申请资料准备",
  }),
]);

export class LocalTrialDemoSeedSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalTrialDemoSeedSafetyError";
  }
}

export async function seedLocalTrialDemo(): Promise<Readonly<{ principals: number; cases: number; tasks: number }>> {
  const environment = process.env;
  const config = loadLocalSyntheticConfig(environment);
  if (config.organizationId !== LOCAL_TRIAL_DEMO_ORGANIZATION.id) {
    throw new LocalTrialDemoSeedSafetyError("Local trial demo requires the canonical local organization.");
  }
  const target = readLocalRelease1SeedTarget(environment);
  const client = new Client({
    connectionString: target.ownerConnectionString,
    application_name: "tianxing-local-trial-demo-seed",
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
    ssl: false,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)", [
      LOCAL_TRIAL_DEMO_ORGANIZATION.id,
      LOCAL_TRIAL_DEMO_FOUNDER.userId,
    ]);
    await seedTrialPrincipals(client, LOCAL_TRIAL_DEMO_FOUNDER.userId);
    await seedCasesAndTasks(client);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const counts = await verifySeed(client);
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function seedTrialPrincipals(client: Client, founderUserId: string): Promise<void> {
  const founderMembership = "51000000-0000-4000-8000-000000000201";
  await client.query(`INSERT INTO access_trial_members
    (membership_id,organization_id,user_id,level,categories,status,created_by_user_id,updated_by_user_id)
    VALUES ($1,$2,$3,'founder','{}','active',$3,$3)
    ON CONFLICT (membership_id) DO NOTHING`, [
    founderMembership, LOCAL_TRIAL_DEMO_ORGANIZATION.id, founderUserId,
  ]);
  for (const principal of LOCAL_TRIAL_DEMO_PRINCIPALS) {
    await client.query(`INSERT INTO identity_users
      (id,normalized_email,status,activated_at,created_by_user_id)
      VALUES ($1,$2,'active',transaction_timestamp(),$3)
      ON CONFLICT (id) DO NOTHING`, [principal.userId, principal.normalizedEmail, founderUserId]);
    await client.query(`INSERT INTO access_organization_memberships
      (id,organization_id,user_id,status,activated_at,created_by_user_id)
      VALUES ($1,$2,$3,'active',transaction_timestamp(),$4)
      ON CONFLICT (id) DO NOTHING`, [
      principal.membershipId, LOCAL_TRIAL_DEMO_ORGANIZATION.id, principal.userId, founderUserId,
    ]);
    await client.query(`INSERT INTO access_employee_profiles
      (membership_id,organization_id,display_name,employment_type)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (membership_id) DO NOTHING`, [
      principal.membershipId, LOCAL_TRIAL_DEMO_ORGANIZATION.id,
      principal.displayName, principal.employmentType,
    ]);
    await client.query(`INSERT INTO access_trial_members
      (membership_id,organization_id,user_id,level,categories,status,created_by_user_id,updated_by_user_id)
      VALUES ($1,$2,$3,$4,$5::text[],'active',$6,$6)
      ON CONFLICT (membership_id) DO NOTHING`, [
      principal.membershipId, LOCAL_TRIAL_DEMO_ORGANIZATION.id, principal.userId,
      principal.role, [...principal.categories], founderUserId,
    ]);
    await client.query(`INSERT INTO access_role_bindings
      (id,organization_id,membership_id,user_id,role,status,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,'active',$6)
      ON CONFLICT (id) DO NOTHING`, [
      principal.roleBindingId, LOCAL_TRIAL_DEMO_ORGANIZATION.id,
      principal.membershipId, principal.userId, principal.role, founderUserId,
    ]);
  }
}

async function seedCasesAndTasks(client: Client): Promise<void> {
  for (const demoCase of DEMO_CASES) {
    const existingCase = await client.query<{
      case_number: string;
      business_category: string;
      stage: string;
    }>(`SELECT case_number,business_category,stage
      FROM cases_service_cases
      WHERE id=$1 AND organization_id=$2`, [demoCase.id, LOCAL_TRIAL_DEMO_ORGANIZATION.id]);
    if (existingCase.rows.length > 0) {
      const existing = existingCase.rows[0]!;
      if (
        existing.case_number !== demoCase.number ||
        existing.business_category !== demoCase.category ||
        existing.stage !== "background_collection"
      ) {
        throw new LocalTrialDemoSeedSafetyError("Existing local trial demo case is inconsistent.");
      }
      continue;
    }
    const owner = LOCAL_TRIAL_DEMO_PRINCIPALS.find((principal) => principal.loginRole === demoCase.ownerLoginRole)!;
    await client.query(`INSERT INTO cases_service_cases
      (id,organization_id,student_id,case_number,application_type,intake_year,admission_type,
       primary_role_binding_id,primary_membership_id,primary_user_id,primary_role,stage,workflow_status,
       record_version,current_primary_advisor_assignment_id,business_category)
      VALUES ($1,$2,$3,$4,'k12',2027,'entry',$5,$6,$7,$8,'signed','active',1,$9,$10)
      ON CONFLICT (id) DO NOTHING`, [
      demoCase.id, LOCAL_TRIAL_DEMO_ORGANIZATION.id, demoCase.studentId, demoCase.number,
      owner.roleBindingId, owner.membershipId, owner.userId, owner.role, demoCase.assignmentId, demoCase.category,
    ]);
    await client.query(`INSERT INTO cases_primary_advisor_assignments
      (id,organization_id,service_case_id,advisor_role_binding_id,membership_id,advisor_user_id,advisor_role,
       starts_at,assignment_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,transaction_timestamp(),'local_trial_demo_owner')
      ON CONFLICT (id) DO NOTHING`, [
      demoCase.assignmentId, LOCAL_TRIAL_DEMO_ORGANIZATION.id, demoCase.id,
      owner.roleBindingId, owner.membershipId, owner.userId, owner.role,
    ]);
    await client.query(`INSERT INTO cases_assessments
      (id,organization_id,service_case_id,manifest_id,status,record_version)
      VALUES ($1,$2,$3,$4,'draft',1)
      ON CONFLICT (organization_id,service_case_id,manifest_id) DO NOTHING`, [
      `51000000-0000-4000-8000-${demoCase.id.slice(-12)}`, LOCAL_TRIAL_DEMO_ORGANIZATION.id, demoCase.id, MANIFEST_ID,
    ]);
    const transition = await client.query<{ decision: string }>(
      `SELECT decision FROM cases_advance_new_service_case($1,'founder',$2,transaction_timestamp())`,
      [demoCase.id, demoCase.transitionFactId],
    );
    if (transition.rows[0]?.decision !== "allowed") {
      throw new LocalTrialDemoSeedSafetyError("Local trial demo case transition was not allowed.");
    }
    const l3 = LOCAL_TRIAL_DEMO_PRINCIPALS.find((principal) => principal.loginRole === "l3")!;
    await client.query(`INSERT INTO tasks_tasks
      (id,organization_id,service_case_id,title,task_brief,due_at,state,assignee_user_id,assignee_role,
       assignee_redaction_profile,owner_user_id,task_kind,creation_trigger,record_version)
      VALUES ($1,$2,$3,$4,$5,transaction_timestamp() + interval '7 days','assigned',$6,'l3','task_only',$7,
       'manual','advisor_manual',1)
      ON CONFLICT (id) DO NOTHING`, [
      demoCase.taskId, LOCAL_TRIAL_DEMO_ORGANIZATION.id, demoCase.id, demoCase.title,
      "跨业务分类演示任务：仅显示被指派的任务资料。", l3.userId, owner.userId,
    ]);
    await client.query(`INSERT INTO tasks_task_assignments
      (id,organization_id,task_id,assignee_user_id,assignee_role,redaction_profile,assigned_by_user_id,status,reason)
      VALUES ($1,$2,$3,$4,'l3','task_only',$5,'assigned','local_trial_demo_assignment')
      ON CONFLICT (id) DO NOTHING`, [
      `51000000-0000-4000-8000-${demoCase.taskId.slice(-12)}`, LOCAL_TRIAL_DEMO_ORGANIZATION.id,
      demoCase.taskId, l3.userId, owner.userId,
    ]);
  }
}

async function verifySeed(client: Client): Promise<Readonly<{ principals: number; cases: number; tasks: number }>> {
  const principalCount = await client.query<{ count: number }>(`SELECT count(*)::int AS count
    FROM access_trial_members WHERE organization_id=$1`, [LOCAL_TRIAL_DEMO_ORGANIZATION.id]);
  const caseCount = await client.query<{ count: number }>(`SELECT count(*)::int AS count
    FROM cases_service_cases WHERE organization_id=$1 AND case_number LIKE 'LOCAL-TRIAL-%'`, [LOCAL_TRIAL_DEMO_ORGANIZATION.id]);
  const taskCount = await client.query<{ count: number }>(`SELECT count(*)::int AS count
    FROM tasks_tasks WHERE organization_id=$1 AND task_brief LIKE '%演示任务%'`, [LOCAL_TRIAL_DEMO_ORGANIZATION.id]);
  const counts = {
    principals: principalCount.rows[0]?.count ?? 0,
    cases: caseCount.rows[0]?.count ?? 0,
    tasks: taskCount.rows[0]?.count ?? 0,
  };
  if (counts.principals !== 5 || counts.cases !== 2 || counts.tasks !== 2) {
    throw new LocalTrialDemoSeedSafetyError(
      `Local trial demo seed verification failed: ${JSON.stringify(counts)}.`,
    );
  }
  return Object.freeze({ principals: 5, cases: 2, tasks: 2 });
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  seedLocalTrialDemo()
    .then((result) => process.stdout.write(`${JSON.stringify({ ...result, status: "pass" })}\n`))
    .catch(() => {
      process.stderr.write("Local trial demo seed failed safely.\n");
      process.exitCode = 1;
    });
}
