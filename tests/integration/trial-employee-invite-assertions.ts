import {getApplicationTenantRunner} from '../../modules/shared/server.ts';
import {PostgresqlUserDirectoryRepository} from '../../modules/identity/infrastructure/postgresql-user-directory-repository.ts';
import {assertInviteOperations} from './trial-invite-operation-assertions.ts';
import type {Browser} from 'playwright-core';
import {assertTrialInviteBrowser} from './trial-employee-invite-browser-assertions.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { OneRoleBaselineTarget } from '../../scripts/db/run-one-role-baseline.ts';
import { createOneRoleBaselineClientConfig } from '../../scripts/db/run-one-role-baseline.ts';
import { NEON_TEST_ORGANIZATION, NEON_TEST_PRINCIPALS } from '../../scripts/db/neon-test-synthetic-fixture.ts';
import { InternalEmailService, InternalEmailServiceError, type InternalEmailInviteActor } from '../../modules/identity/application/internal-email.ts';
import type { DeterministicFakeEmailTransport } from '../../modules/email/infrastructure/deterministic-fake-transport.ts';

export async function assertTrialEmployeeInvites(input: {
  target: OneRoleBaselineTarget; service: InternalEmailService; transport: DeterministicFakeEmailTransport;
  baseUrl: string; founderCookie: string; founderPassword: string; adminCookie:string; browser:Browser;
}): Promise<void> {
  const client = new Client(createOneRoleBaselineClientConfig(input.target));
  const founder = NEON_TEST_PRINCIPALS.find(person => person.role === 'founder')!;
  const org = NEON_TEST_ORGANIZATION.id;
  const actor: InternalEmailInviteActor = { userId: founder.userId, organizationId: org, roles: ['founder'],
    trialPrincipal: { userId: founder.userId, organizationId: org, level: 'founder', categories: [], active: true, recordVersion: 1 } };
  const errorCode = (code: string) => (error: unknown) => error instanceof InternalEmailServiceError && error.code === code;
  const credential = () => {
    const message = input.transport.messages.at(-1)!;
    const url = new URL(message.text.trim().split('\n').at(-1)!);
    const value = new URLSearchParams(url.hash.slice(1)).get('token');
    assert.ok(value); return value;
  };
  let founderCookie = input.founderCookie;
  const requestInvite = (data: Record<string, unknown>, cookie = founderCookie) => fetch(input.baseUrl + '/api/v1/auth/invites', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(data),
  });
  try {
    await client.connect();
    await client.query("SELECT set_config('app.organization_id',$1,false),set_config('app.actor_user_id',$2,false)", [org,founder.userId]);
    await client.query(`INSERT INTO access_trial_members(membership_id,organization_id,user_id,level,categories,created_by_user_id,updated_by_user_id)
      VALUES($1,$2,$3,'founder','{}',$3,$3)`, [founder.membershipId,org,founder.userId]);
    const people = new Map<string, string>();
    for (const level of ['founder','l1','l2','l3'] as const) {
      const categories = level === 'l2' ? ['local_school','international_school'] as const : [];
      const email = `trial-${level}-${randomUUID()}@example.test.invalid`;
      const created = await input.service.createFounderInvite({ actor, normalizedEmail: email, role: level,
        trialCategories: categories, employmentType: 'PART_TIME', displayName: 'Synthetic pending', idempotencyKey: randomUUID() });
      const original = credential();
      people.set(level, created.targetUserId);
      const rows = (await client.query(`SELECT u.status AS user_status,m.status AS membership_status,p.employment_type,
        t.level,t.categories,b.role,i.trial_categories FROM identity_users u
        JOIN access_organization_memberships m ON m.user_id=u.id
        JOIN access_employee_profiles p ON p.membership_id=m.id
        JOIN access_trial_members t ON t.membership_id=m.id
        JOIN access_role_bindings b ON b.membership_id=m.id AND b.status='active'
        JOIN identity_invites i ON i.target_user_id=u.id WHERE u.id=$1`, [created.targetUserId])).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], { user_status:'invited',membership_status:'invited',employment_type:'PART_TIME',
        level,categories:[...categories].sort(),role:level,trial_categories:[...categories].sort() });
      await assert.rejects(input.service.createSession({ email, password:'Synthetic9!TrialInvite' }), errorCode('AUTHENTICATION_FAILED'));
      await input.service.resendFounderInvite({ idempotencyKey:randomUUID(), actor, inviteId:created.inviteId });
      const rotated = credential(); assert.notEqual(rotated, original);
      await assert.rejects(input.service.activateInvite({ activationCredential:original,password:'Synthetic9!TrialInvite',displayName:'Synthetic employee' }), errorCode('INVITE_NOT_FOUND'));
      const activation = await fetch(input.baseUrl + '/api/v1/auth/invite-activations', {
        method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({activation_credential:rotated,password:'Synthetic9!TrialInvite',password_confirmation:'Synthetic9!TrialInvite',display_name:'Synthetic '+level}),
      });
      assert.equal(activation.status,303);
      const cookie = activation.headers.get('set-cookie')?.split(';',1)[0]; assert.ok(cookie);
      assert.equal(new URL(activation.headers.get('location')!).pathname,level==='l3'?'/tasks':'/today');
      const me = await fetch(input.baseUrl + '/api/v1/auth/me',{headers:{cookie}});
      assert.equal(me.status,200); assert.equal((await me.json()).data.role,level);

      await assert.rejects(input.service.activateInvite({activationCredential:rotated,password:'Synthetic9!TrialInvite',displayName:'Again'}),errorCode('INVITE_NOT_REDEEMABLE'));
      const events = (await client.query('SELECT event_type,actor_user_id,metadata FROM audit_events WHERE resource_id=$1 ORDER BY occurred_at',[created.inviteId])).rows;
      assert.deepEqual(events.map(row=>row.event_type),['identity.trial_invite.created','identity.trial_invite.rotated','identity.trial_invite.redeemed']);
      assert.deepEqual(events.map(row=>row.actor_user_id),[founder.userId,founder.userId,created.targetUserId]);
      assert.doesNotMatch(JSON.stringify(events),/Synthetic9|example.test.invalid|secret|token/);
      assert.equal((await client.query('SELECT count(*)::int n FROM audit_outbox WHERE aggregate_id=$1',[created.inviteId])).rows[0].n,3);
      if(level!=='founder'){
        const denied = await requestInvite({normalized_email:`denied-${randomUUID()}@example.test.invalid`,role:'l3',trial_categories:[]},cookie);
        assert.equal(denied.status,403, 'non-Founder invitation denied: '+level+' '+JSON.stringify(await denied.json()));
        const resendDenied=await fetch(input.baseUrl+'/api/v1/auth/invites/'+created.inviteId+'/resend',{
          method:'POST',headers:{cookie,'idempotency-key':randomUUID()},
        });
        assert.equal(resendDenied.status,403);
        assert.equal((await fetch(input.baseUrl+'/api/v1/auth/users',{headers:{cookie}})).status,403);
      }
      // Signing in rotates the one active internal-email session; verify it last.
      const signedIn = await input.service.createSession({email,password:'Synthetic9!TrialInvite'});
      assert.equal(signedIn.actor.role,level);
    }
    // The earlier browser logout revokes the original Founder's session.
    assert.equal((await requestInvite({normalized_email:`stale-${randomUUID()}@example.test.invalid`,role:'l3',trial_categories:[]})).status,401);
    const login = await fetch(input.baseUrl+'/api/v1/auth/login',{
      method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({email:founder.email,password:input.founderPassword}),
    });
    assert.equal(login.status,303);
    founderCookie=login.headers.get('set-cookie')?.split(';',1)[0]??'';
    assert.ok(founderCookie);
    // Current Founder cannot use an old-role request to create an unscoped legacy employee.
    assert.equal((await requestInvite({normalized_email:`legacy-${randomUUID()}@example.test.invalid`,role:'advisor'})).status,422);
    const formal = await requestInvite({normalized_email:`formal-${randomUUID()}@example.test.invalid`,role:'l2',trial_categories:['international_school'],employment_type:'PART_TIME'});
    assert.equal(formal.status,200);
    const receipt = await formal.json();
    assert.doesNotMatch(JSON.stringify(receipt),/activation_credential|secret_hash|token=/);
    assert.equal((await client.query('SELECT level FROM access_trial_members WHERE user_id=$1',[receipt.data.target_user_id])).rows[0].level,'l2');
    const directory=await fetch(input.baseUrl+'/api/v1/auth/users',{headers:{cookie:founderCookie}});
    assert.equal(directory.status,200);
    const directoryData=(await directory.json()).data;
    assert.equal(directoryData.invitation_model,'trial');
    const explicitFounder=directoryData.users.find((user:{user_id:string})=>user.user_id===founder.userId);
    assert.equal(explicitFounder.trial_level,'founder');
    // Legacy Admin cannot change a trial Founder's personnel via the old editor.
    const oldEdit=await fetch(input.baseUrl+'/api/v1/auth/users/'+founder.userId+'/access',{
      method:'PATCH',headers:{cookie:input.adminCookie,'content-type':'application/json','idempotency-key':randomUUID()},
      body:JSON.stringify({display_name:'Forbidden edit',employment_type:'FULL_TIME',roles:['founder'],expected_access_version:explicitFounder.access_version}),
    });
    assert.equal(oldEdit.status,403);
    await assertTrialInviteBrowser({browser:input.browser,baseUrl:input.baseUrl,cookie:founderCookie,client});
    const pending = await input.service.createFounderInvite({actor,normalizedEmail:`disabled-${randomUUID()}@example.test.invalid`,role:'l3',trialCategories:[],idempotencyKey:randomUUID()});
    const pendingCredential = credential();
    await client.query(`UPDATE access_trial_members SET status='disabled',record_version=record_version+1,updated_by_user_id=$2 WHERE user_id=$1`,[pending.targetUserId,founder.userId]);
    await assert.rejects(input.service.activateInvite({activationCredential:pendingCredential,password:'Synthetic9!TrialInvite',displayName:'No access'}),errorCode('INVITE_NOT_REDEEMABLE'));
    const directoryRepository=new PostgresqlUserDirectoryRepository(getApplicationTenantRunner());
    await assert.rejects(directoryRepository.listUsers({organizationId:org,actorUserId:people.get('l1')!}),
      (error:unknown)=>(error as {code?:string}).code==='FORBIDDEN');
    // Stale/fabricated request-time Founder facts cannot bypass the current role during a resend.
    const forged = {...actor,userId:people.get('l1')!,trialPrincipal:{...actor.trialPrincipal!,userId:people.get('l1')!}};
    await assert.rejects(input.service.resendFounderInvite({idempotencyKey:randomUUID(),actor:forged,inviteId:receipt.data.invite_id}),errorCode('FOUNDER_REQUIRED'));
    await assert.rejects(input.service.createFounderInvite({actor:forged,normalizedEmail:`forged-${randomUUID()}@example.test.invalid`,role:'l3',trialCategories:[],idempotencyKey:randomUUID()}),errorCode('FOUNDER_REQUIRED'));
    // An audit failure must roll back the entire identity and must not send mail.
    const rollbackEmail = `rollback-${randomUUID()}@example.test.invalid`;
    const beforeMessages = input.transport.messages.length;
    await client.query("ALTER TABLE audit_events ADD CONSTRAINT trial_invite_test_audit_failure CHECK (event_type <> 'identity.trial_invite.created') NOT VALID");
    try {
      await assert.rejects(input.service.createFounderInvite({actor,normalizedEmail:rollbackEmail,role:'l3',trialCategories:[],idempotencyKey:randomUUID()}),errorCode('INVITE_UNAVAILABLE'));
      assert.equal((await client.query('SELECT count(*)::int n FROM identity_users WHERE normalized_email=$1',[rollbackEmail])).rows[0].n,0);
      assert.equal(input.transport.messages.length,beforeMessages);
    } finally {
      await client.query('ALTER TABLE audit_events DROP CONSTRAINT trial_invite_test_audit_failure');
    }
    const recovered = await input.service.createFounderInvite({actor,normalizedEmail:rollbackEmail,role:'l3',trialCategories:[],idempotencyKey:randomUUID()});
    const recoveredCredential = credential();
    await client.query("ALTER TABLE audit_events ADD CONSTRAINT trial_invite_test_audit_failure CHECK (event_type <> 'identity.trial_invite.redeemed') NOT VALID");
    try {
      await assert.rejects(input.service.activateInvite({activationCredential:recoveredCredential,password:'Synthetic9!TrialInvite',displayName:'Rollback activation'}),errorCode('INVITE_UNAVAILABLE'));
      const state = (await client.query(`SELECT u.status AS user_status,m.status AS membership_status,i.status AS invite_status,
        (SELECT count(*)::int FROM identity_internal_credentials c WHERE c.user_id=u.id) AS credentials,
        (SELECT count(*)::int FROM identity_sessions s WHERE s.user_id=u.id) AS sessions
        FROM identity_users u JOIN access_organization_memberships m ON m.user_id=u.id
        JOIN identity_invites i ON i.target_user_id=u.id WHERE u.id=$1`,[recovered.targetUserId])).rows[0];
      assert.deepEqual(state,{user_status:'invited',membership_status:'invited',invite_status:'created',credentials:0,sessions:0});
    } finally {
      await client.query('ALTER TABLE audit_events DROP CONSTRAINT trial_invite_test_audit_failure');
    }
    assert.equal((await input.service.activateInvite({activationCredential:recoveredCredential,password:'Synthetic9!TrialInvite',displayName:'Recovered activation'})).actor.role,'l3');
    // The original invitation scope is historical evidence, not an editable activation parameter.
    await assert.rejects(client.query("UPDATE identity_invites SET trial_categories='{}',record_version=record_version+1 WHERE id=$1",[receipt.data.invite_id]),(e:unknown)=>(e as {code?:string}).code==='23514');
    await assertInviteOperations({service:input.service,actor,client,transport:input.transport,baseUrl:input.baseUrl,cookie:founderCookie});
    process.stdout.write(JSON.stringify({trial_employee_invites:'pass',grades:4,pending_login:'denied',resend:'old_link_invalid',activation:'actual_grade',l3_landing:'tasks',stale_founder:'denied',audit:'atomic_history'})+'\n');
  } finally { await client.end(); }
}
