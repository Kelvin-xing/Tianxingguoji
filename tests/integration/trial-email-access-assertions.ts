import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { buildAccessContext, type AccessContext, type Release1OrganizationRole } from '../../modules/access/public.ts';
import type { TenantTransactionRunner } from '../../modules/shared/server.ts';
import { EmailSettingsService, EmailSettingsError } from '../../modules/email/application/settings.ts';
import { EmailTemplateService, EmailTemplateError } from '../../modules/email/application/templates.ts';
import { PostgresqlEmailSettingsRepository } from '../../modules/email/infrastructure/postgresql-settings-repository.ts';
import { PostgresqlEmailTemplateRepository } from '../../modules/email/infrastructure/postgresql-template-repository.ts';
import { AesGcmEmailSecretBox } from '../../modules/email/infrastructure/secret-box.ts';

type Person = { userId: string; membershipId: string };
export async function assertTrialEmailAccess(input: {
  client: Client; runner: TenantTransactionRunner; organizationId: string;
  founder: Person; l1: Person; l2: Person; l3: Person; legacy: Person;
}): Promise<void> {
  const { client, organizationId: org } = input;
  await client.query('SAVEPOINT trial_email');
  try {
    const runner: TenantTransactionRunner = { async run(context, operation) {
      await client.query('SAVEPOINT email_operation');
      try { return await input.runner.run(context, operation); }
      catch (error) { await client.query('ROLLBACK TO SAVEPOINT email_operation'); throw error; }
      finally { await client.query('RELEASE SAVEPOINT email_operation'); }
    } };
    const settings = new PostgresqlEmailSettingsRepository(runner);
    const templates = new PostgresqlEmailTemplateRepository(runner);
    const secretBox = new AesGcmEmailSecretBox(Buffer.alloc(32, 9), 'trial-v1');
    // This helper shares one outer rollback transaction. Use its database clock
    // for initial creation, as the existing update triggers use that same clock.
    const fixtureTime = new Date((await client.query('SELECT transaction_timestamp() AS now')).rows[0].now).getTime();
    let now = fixtureTime;
    const settingsService = new EmailSettingsService({ repository: settings, secretBox, now: () => now });
    const templateService = new EmailTemplateService({ repository: templates, now: () => now });
    const actor = (person: Person, role: Release1OrganizationRole, trial = true): AccessContext => buildAccessContext({
      userId: person.userId, organizationId: org, membershipId: person.membershipId,
      roles: [role], membershipRecordVersion: 1, roleBindingRecordVersions: [1],
      ...(trial && role !== 'admin' && role !== 'advisor' && role !== 'contractor' ? {
        trialPrincipal: { userId: person.userId, organizationId: org, level: role,
          active: true, categories: role === 'l2' ? ['international_school' as const] : [], recordVersion: 1 },
      } : {}),
    });
    const founder = actor(input.founder, 'founder');
    const read = (userId: string) => ({ organizationId: org, actorUserId: userId });
    const templateRead = (userId: string) => ({ ...read(userId), kind: 'internal_user_invitation' as const });
    const settingsDenied = (error: unknown) => error instanceof EmailSettingsError && error.code === 'FORBIDDEN';
    const templateDenied = (error: unknown) => error instanceof EmailTemplateError && error.code === 'FORBIDDEN';
    const settingsCommand = {
      apiKey: 're_synthetic_trial_email', fromEmail: 'trial@example.test.invalid', fromName: 'Synthetic',
      expectedRecordVersion: null, idempotencyKey: randomUUID(), requestId: randomUUID(),
    };
    const templateCommand = {
      subject: 'Synthetic invitation', bodyText: 'Synthetic trial instructions.',
      expectedRecordVersion: null, idempotencyKey: randomUUID(), requestId: randomUUID(),
    };
    assert.equal((await settingsService.getStatus(founder)).configured, false);
    assert.equal((await templateService.get(founder)).customized, false);
    for (const [person, role] of [[input.l1, 'l1'], [input.l2, 'l2'], [input.l3, 'l3']] as const) {
      const current = actor(person, role);
      assert.throws(() => settingsService.getStatus(current), settingsDenied);
      assert.throws(() => templateService.get(current), templateDenied);
      assert.throws(() => settingsService.save({ actor: current, command: settingsCommand }), settingsDenied);
      assert.throws(() => templateService.save({ actor: current, command: templateCommand }), templateDenied);
      // Bypassing the service or forging a cached Founder must not bypass current DB facts.
      await assert.rejects(settings.readStatus(read(person.userId)), settingsDenied);
      await assert.rejects(templates.read(templateRead(person.userId)), templateDenied);
      await assert.rejects(settings.readDeliverySettings(read(person.userId)), settingsDenied);
      await assert.rejects(templates.readDeliveryTemplate(templateRead(person.userId)), templateDenied);
      await assert.rejects(settingsService.save({ actor: actor(person, 'founder'), command: settingsCommand }), settingsDenied);
      await assert.rejects(templateService.save({ actor: actor(person, 'founder'), command: templateCommand }), templateDenied);
    }
    const firstSettings = await settingsService.save({ actor: founder, command: settingsCommand });
    const firstTemplate = await templateService.save({ actor: founder, command: templateCommand });
    assert.equal(firstSettings.recordVersion, 1); assert.equal(firstTemplate.recordVersion, 1);
    now = fixtureTime + 1_000;
    assert.deepEqual(await settingsService.save({ actor: founder, command: settingsCommand }), { ...firstSettings, replayed: true });
    assert.deepEqual(await templateService.save({ actor: founder, command: templateCommand }), { ...firstTemplate, replayed: true });
    now = fixtureTime;
    const status = await settingsService.getStatus(founder);
    assert.equal(status.fromEmail, settingsCommand.fromEmail);
    assert.doesNotMatch(JSON.stringify(status), /re_synthetic|ciphertext|authTag/);
    const delivery = await settings.readDeliverySettings(read(founder.userId));
    assert.ok(delivery);
    assert.notEqual(Buffer.from(delivery.secret.ciphertext).toString('utf8'), settingsCommand.apiKey);
    assert.equal(secretBox.open({ organizationId: org, secret: delivery.secret }), settingsCommand.apiKey);
    assert.equal((await templates.readDeliveryTemplate(templateRead(founder.userId))).subject, templateCommand.subject);
    for (const event of ['email.provider_settings.updated', 'email.template.updated']) {
      const rows = (await client.query('SELECT metadata FROM audit_events WHERE event_type=$1', [event])).rows;
      assert.equal(rows.length, 1);
      assert.doesNotMatch(JSON.stringify(rows), /re_synthetic|Synthetic trial|example.test.invalid/);
    }
    await assert.rejects(settingsService.save({ actor: founder, command: { ...settingsCommand, idempotencyKey: randomUUID() } }), (e: unknown) => e instanceof EmailSettingsError && e.code === 'STALE_VERSION');
    await assert.rejects(templateService.save({ actor: founder, command: { ...templateCommand, idempotencyKey: randomUUID() } }), (e: unknown) => e instanceof EmailTemplateError && e.code === 'STALE_VERSION');
    // An audit failure must roll back the secret/template change and idempotency claim.
    for (const kind of ['settings', 'template'] as const) {
      const duplicateAudit = (await client.query('SELECT id FROM audit_events LIMIT 1')).rows[0].id as string;
      let count = 0;
      const createId = () => count++ === 0 ? duplicateAudit : randomUUID();
      const command = { ...(kind === 'settings' ? settingsCommand : templateCommand), expectedRecordVersion: 1,
        idempotencyKey: randomUUID(), requestId: randomUUID() };
      const beforeSettings = await settingsService.getStatus(founder);
      const beforeTemplate = await templateService.get(founder);
      if (kind === 'settings') {
        const write = { actor: founder, command: { ...settingsCommand, ...command } };
        const failing = new EmailSettingsService({ repository: settings, secretBox, createId });
        await assert.rejects(failing.save(write), (error: unknown) => error instanceof EmailSettingsError && error.code === 'UNAVAILABLE');
        assert.deepEqual(await settingsService.getStatus(founder), beforeSettings);
        assert.equal((await settingsService.save(write)).recordVersion, 2);
      } else {
        const write = { actor: founder, command: { ...templateCommand, ...command } };
        const failing = new EmailTemplateService({ repository: templates, createId });
        await assert.rejects(failing.save(write), (error: unknown) => error instanceof EmailTemplateError && error.code === 'UNAVAILABLE');
        assert.deepEqual(await templateService.get(founder), beforeTemplate);
        assert.equal((await templateService.save(write)).recordVersion, 2);
      }
    }
    // Replaying the first mutation after later writes still returns its original version/time.
    now = fixtureTime + 1_000;
    assert.deepEqual(await settingsService.save({ actor: founder, command: settingsCommand }), { ...firstSettings, replayed: true });
    assert.deepEqual(await templateService.save({ actor: founder, command: templateCommand }), { ...firstTemplate, replayed: true });
    now = fixtureTime;
    await client.query('SAVEPOINT email_disabled');
    await client.query("UPDATE identity_users SET status='disabled',session_version=session_version+1,record_version=record_version+1 WHERE id=$1", [founder.userId]);
    await assert.rejects(settingsService.getStatus(founder), settingsDenied);
    await assert.rejects(templateService.get(founder), templateDenied);
    await assert.rejects(settingsService.save({ actor: founder, command: settingsCommand }), settingsDenied);
    await assert.rejects(templateService.save({ actor: founder, command: templateCommand }), templateDenied);
    await assert.rejects(settings.readDeliverySettings(read(founder.userId)), settingsDenied);
    await assert.rejects(templates.readDeliveryTemplate(templateRead(founder.userId)), templateDenied);
    await client.query('ROLLBACK TO SAVEPOINT email_disabled');

    // Historical Admin can manage, but cannot use the Founder delivery path.
    await client.query("SELECT set_config('app.actor_user_id',$1,true)", [founder.userId]);
    const binding = randomUUID();
    await client.query(`INSERT INTO access_role_bindings(id,organization_id,membership_id,user_id,role,status,created_by_user_id)
      VALUES ($1,$2,$3,$4,'admin','active',$5)`, [binding,org,input.legacy.membershipId,input.legacy.userId,founder.userId]);
    const admin = actor(input.legacy, 'admin', false);
    assert.equal((await settingsService.getStatus(admin)).configured, true);
    assert.equal((await templateService.get(admin)).customized, true);
    assert.equal((await settingsService.save({actor:admin,command:{...settingsCommand,expectedRecordVersion:2,idempotencyKey:randomUUID()}})).recordVersion,3);
    assert.equal((await templateService.save({actor:admin,command:{...templateCommand,expectedRecordVersion:2,idempotencyKey:randomUUID()}})).recordVersion,3);
    await assert.rejects(settings.readDeliverySettings(read(admin.userId)), settingsDenied);
    await assert.rejects(templates.readDeliveryTemplate(templateRead(admin.userId)), templateDenied);
    await client.query("UPDATE access_role_bindings SET status='revoked',record_version=record_version+1 WHERE id=$1", [binding]);
    await client.query(`INSERT INTO access_role_bindings(id,organization_id,membership_id,user_id,role,status,created_by_user_id)
      VALUES ($1,$2,$3,$4,'founder','active',$5)`, [randomUUID(),org,input.legacy.membershipId,input.legacy.userId,founder.userId]);
    await assert.rejects(settingsService.getStatus(admin), settingsDenied);
    await assert.rejects(templateService.get(admin), templateDenied);
    assert.ok(await settings.readDeliverySettings(read(admin.userId)));
    assert.equal((await templates.readDeliveryTemplate(templateRead(admin.userId))).subject, templateCommand.subject);
    process.stdout.write(JSON.stringify({ trial_email_access: 'pass', trial: 'founder_only', legacy: 'admin_management_founder_delivery', revoked: 'read_and_replay_denied', secret: 'encrypted_not_returned' }) + '\n');
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT trial_email');
    await client.query('RELEASE SAVEPOINT trial_email');
  }
}
