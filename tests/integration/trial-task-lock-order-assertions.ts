import assert from 'node:assert/strict';
import {Client} from 'pg';
import {createOneRoleBaselineClientConfig,type OneRoleBaselineTarget} from '../../scripts/db/run-one-role-baseline.ts';

/** Hold the same case-first lock as a file write, then start a real task command.
 * Once PG proves the command is waiting, it must not already hold the task lock. */
export async function assertTaskWaitsWithoutHoldingTask<Result>(input:{target:OneRoleBaselineTarget;observer:Client;
  organizationId:string;actorUserId:string;caseId:string;taskId:string;command:()=>Promise<Result>}):Promise<Result>{
  const locker=new Client(createOneRoleBaselineClientConfig(input.target));
  let pending:Promise<Result>|undefined;
  try{
    await locker.connect();await locker.query('BEGIN');
    await locker.query("SELECT set_config('app.organization_id',$1,true),set_config('app.actor_user_id',$2,true)",[input.organizationId,input.actorUserId]);
    const pid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('SELECT id FROM cases_service_cases WHERE id=$1 FOR UPDATE',[input.caseId]);
    pending=input.command();void pending.catch(()=>undefined);
    const deadline=Date.now()+15_000;
    let blocked=false;
    while(Date.now()<deadline){
      const waiters=await input.observer.query(`SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
        AND (query LIKE '%FROM cases_school_targets AS target%' OR query LIKE 'SELECT id FROM cases_service_cases WHERE organization_id=%')`,[pid]);
      if(waiters.rows.length>0){blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(blocked,true,'PG must confirm the actual task request is waiting on the case lock');
    // NOWAIT makes a reversed lock order fail deterministically, without waiting for a deadlock timeout.
    await locker.query('SELECT id FROM tasks_tasks WHERE id=$1 FOR SHARE NOWAIT',[input.taskId]);
    await locker.query('ROLLBACK');
    const result=await pending;
    process.stdout.write(JSON.stringify({trial_task_lock_order:'pass',case:'held_by_file_transaction',task:'not_held_while_waiting'})+'\n');
    return result;
  }finally{
    await locker.query('ROLLBACK').catch(()=>undefined);await locker.end();
    await pending?.catch(()=>undefined);
  }
}
