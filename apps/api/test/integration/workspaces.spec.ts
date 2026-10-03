import { createPrismaClient, type PrismaClient } from '@sotto/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Person, bootApp, withDatabase, type TestApp } from './harness.js';

/**
 * Workspaces, members, invites and roles, as one team would use them: Ada creates Kestrel Labs,
 * invites Tunde, promotes him, and so on. Steps run in order and build on each other.
 */
describe.skipIf(withDatabase)('workspaces, members and invites', () => {
  let t: TestApp;
  let db: PrismaClient;
  let ada: Person;
  let tunde: Person;
  let workspaceId: string;

  const inviteToken = (to: string) => t.mailer.lastLink(to, '/invite/').split('/invite/')[1]!;
  const actions = async () =>
    (await db.auditLog.findMany({ where: { workspaceId }, orderBy: { at: 'asc' } })).map(
      (e) => e.action,
    );

  beforeAll(async () => {
    t = await bootApp();
    db = createPrismaClient(t.databaseUrl);
    ada = new Person(t, 'ada@kestrel.example');
    tunde = new Person(t, 'tunde@kestrel.example');
    await ada.signIn();
    await ada.patch('/api/v1/me', { name: 'Ada Okafor' }).expect(200);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await t?.close();
  });

  it('creates a workspace, makes its creator the owner and switches to it', async () => {
    const res = await ada.post('/api/v1/workspaces', { name: '  Kestrel Labs ' }).expect(201);
    expect(res.body).toMatchObject({
      name: 'Kestrel Labs',
      role: 'owner',
      active: true,
      members: 1,
    });
    workspaceId = res.body.id;

    const me = await ada.get('/api/v1/me').expect(200);
    expect(me.body.workspace).toEqual({
      id: workspaceId,
      name: 'Kestrel Labs',
      role: 'owner',
      sample: false,
    });
    const list = await ada.get('/api/v1/workspaces').expect(200);
    expect(list.body).toEqual([
      { id: workspaceId, name: 'Kestrel Labs', role: 'owner', active: true, members: 1 },
    ]);
    expect(await actions()).toEqual(['workspace.created']);
  });

  it('refuses an empty workspace name', async () => {
    const res = await ada.post('/api/v1/workspaces', { name: '   ' }).expect(400);
    expect(res.body.error.message).toContain('Name the workspace.');
  });

  it('invites someone by email and shows the invite to anyone holding the link', async () => {
    const res = await ada
      .post('/api/v1/invites', { email: 'Tunde@Kestrel.example', role: 'member' })
      .expect(201);
    expect(res.body).toMatchObject({
      email: 'tunde@kestrel.example',
      role: 'member',
      expired: false,
    });

    const mail = t.mailer.sent.at(-1)!;
    expect(mail.to).toBe('tunde@kestrel.example');
    expect(mail.subject).toBe('Ada Okafor invited you to Kestrel Labs on Sotto');
    expect(inviteToken('tunde@kestrel.example')).toBe(res.body.id);

    const preview = await request(t.app.getHttpServer())
      .get(`/api/v1/invites/${res.body.id}`)
      .expect(200);
    expect(preview.body).toMatchObject({
      workspace: { name: 'Kestrel Labs' },
      invitedBy: { name: 'Ada Okafor', email: 'ada@kestrel.example' },
      email: 'tunde@kestrel.example',
      role: 'member',
      state: 'pending',
    });
    await request(t.app.getHttpServer()).get('/api/v1/invites/not-a-real-token').expect(404);
  });

  it('lists members and open invites for admins', async () => {
    const res = await ada.get('/api/v1/members').expect(200);
    expect(res.body.members).toEqual([
      expect.objectContaining({ email: 'ada@kestrel.example', role: 'owner', you: true }),
    ]);
    expect(res.body.invites).toEqual([
      expect.objectContaining({
        email: 'tunde@kestrel.example',
        role: 'member',
        invitedBy: { name: 'Ada Okafor', email: 'ada@kestrel.example' },
      }),
    ]);
  });

  it('only lets the person it was sent to accept an invite', async () => {
    const token = inviteToken('tunde@kestrel.example');
    const jonas = new Person(t, 'jonas@kestrel.example');
    await jonas.signIn();
    const res = await jonas.post(`/api/v1/invites/${token}/accept`).expect(403);
    expect(res.body.error.message).toBe(
      'This invite was sent to a different email address. Sign in with that address to accept it.',
    );
  });

  it('accepting joins the workspace with the invited role and switches to it', async () => {
    await tunde.signIn();
    expect((await tunde.get('/api/v1/me')).body.workspace).toBeNull();

    const token = inviteToken('tunde@kestrel.example');
    const res = await tunde.post(`/api/v1/invites/${token}/accept`).expect(200);
    expect(res.body).toMatchObject({
      id: workspaceId,
      name: 'Kestrel Labs',
      role: 'member',
      active: true,
      members: 2,
    });
    const me = await tunde.get('/api/v1/me').expect(200);
    expect(me.body.workspace).toMatchObject({ id: workspaceId, role: 'member' });

    const preview = await request(t.app.getHttpServer())
      .get(`/api/v1/invites/${token}`)
      .expect(200);
    expect(preview.body.state).toBe('accepted');
    await tunde.post(`/api/v1/invites/${token}/accept`).expect(400);
  });

  it('keeps members out of admin actions', async () => {
    const list = await tunde.get('/api/v1/members').expect(403);
    expect(list.body.error).toMatchObject({
      code: 'ROLE_REQUIRED',
      message: 'Only admins and owners can do this.',
    });
    await tunde.post('/api/v1/invites', { email: 'x@kestrel.example', role: 'viewer' }).expect(403);
    await tunde.patch('/api/v1/workspace', { name: 'Tunde’s now' }).expect(403);
  });

  it('lets an owner promote a member to admin, and records it', async () => {
    const { body } = await ada.get('/api/v1/members').expect(200);
    const membership = body.members.find(
      (m: { email: string }) => m.email === 'tunde@kestrel.example',
    );
    const res = await ada.patch(`/api/v1/members/${membership.id}`, { role: 'admin' }).expect(200);
    expect(res.body).toMatchObject({ email: 'tunde@kestrel.example', role: 'admin', you: false });

    const entry = await db.auditLog.findFirst({
      where: { workspaceId, action: 'member.role_changed' },
    });
    expect(entry?.meta).toMatchObject({
      email: 'tunde@kestrel.example',
      from: 'Member',
      to: 'Admin',
    });
  });

  it('lets admins run the team but not touch owners', async () => {
    await tunde.get('/api/v1/members').expect(200);
    await tunde
      .post('/api/v1/invites', { email: 'priya@kestrel.example', role: 'viewer' })
      .expect(201);

    const owner = await tunde
      .post('/api/v1/invites', { email: 'kwame@kestrel.example', role: 'owner' })
      .expect(403);
    expect(owner.body.error.message).toBe('Only owners can invite another owner.');

    const { body } = await tunde.get('/api/v1/members').expect(200);
    const adaMembership = body.members.find(
      (m: { email: string }) => m.email === 'ada@kestrel.example',
    );
    const demote = await tunde
      .patch(`/api/v1/members/${adaMembership.id}`, { role: 'member' })
      .expect(403);
    expect(demote.body.error.message).toBe('Only owners can change an owner’s role.');
    const remove = await tunde.delete(`/api/v1/members/${adaMembership.id}`).expect(403);
    expect(remove.body.error.message).toBe('Only owners can remove an owner.');
  });

  it('renames the workspace for admins', async () => {
    const res = await tunde.patch('/api/v1/workspace', { name: 'Kestrel' }).expect(200);
    expect(res.body).toMatchObject({ id: workspaceId, name: 'Kestrel', role: 'admin' });
    const entry = await db.auditLog.findFirst({
      where: { workspaceId, action: 'workspace.renamed' },
    });
    expect(entry?.meta).toEqual({ from: 'Kestrel Labs', to: 'Kestrel' });
  });

  it('resends an invite with the same link and withdraws one', async () => {
    const first = await ada
      .post('/api/v1/invites', { email: 'sofia@kestrel.example', role: 'member' })
      .expect(201);
    const again = await ada
      .post('/api/v1/invites', { email: 'sofia@kestrel.example', role: 'member', resend: true })
      .expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(t.mailer.sent.filter((m) => m.to === 'sofia@kestrel.example')).toHaveLength(2);

    await ada.delete(`/api/v1/invites/${first.body.id}`).expect(204);
    const preview = await request(t.app.getHttpServer())
      .get(`/api/v1/invites/${first.body.id}`)
      .expect(200);
    expect(preview.body.state).toBe('revoked');

    const sofia = new Person(t, 'sofia@kestrel.example');
    await sofia.signIn();
    const res = await sofia.post(`/api/v1/invites/${first.body.id}/accept`).expect(400);
    expect(res.body.error.message).toBe(
      'This invite has expired or was withdrawn. Ask for a new one.',
    );
  });

  it('removes a member: their access ends at once', async () => {
    const { body } = await ada.get('/api/v1/members').expect(200);
    const membership = body.members.find(
      (m: { email: string }) => m.email === 'tunde@kestrel.example',
    );
    await ada.delete(`/api/v1/members/${membership.id}`).expect(204);

    const me = await tunde.get('/api/v1/me').expect(200);
    expect(me.body.workspace).toBeNull();
    const denied = await tunde.get('/api/v1/members').expect(403);
    expect(denied.body.error.code).toBe('NO_WORKSPACE');
  });

  it('switches between workspaces and remembers the last one at the next sign-in', async () => {
    const second = await ada.post('/api/v1/workspaces', { name: 'Side project' }).expect(201);
    let list = await ada.get('/api/v1/workspaces').expect(200);
    expect(list.body.map((w: { name: string; active: boolean }) => [w.name, w.active])).toEqual([
      ['Kestrel', false],
      ['Side project', true],
    ]);

    await ada.post(`/api/v1/workspaces/${workspaceId}/activate`).expect(200);
    list = await ada.get('/api/v1/workspaces').expect(200);
    expect(list.body.find((w: { active: boolean }) => w.active).id).toBe(workspaceId);

    await tunde.post(`/api/v1/workspaces/${second.body.id}/activate`).expect(403);

    const adaOnPhone = new Person(t, 'ada@kestrel.example');
    await adaOnPhone.signIn();
    expect((await adaOnPhone.get('/api/v1/me')).body.workspace.id).toBe(workspaceId);
  });

  it('wrote every change to the audit log', async () => {
    expect(await actions()).toEqual([
      'workspace.created',
      'invite.sent',
      'member.joined',
      'member.role_changed',
      'invite.sent',
      'workspace.renamed',
      'invite.sent',
      'invite.resent',
      'invite.revoked',
      'member.removed',
    ]);
    const joined = await db.auditLog.findFirst({ where: { workspaceId, action: 'member.joined' } });
    expect(joined?.ip).toEqual(expect.any(String));
  });
});
