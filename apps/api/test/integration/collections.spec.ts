import { createPrismaClient, type PrismaClient } from '@sotto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell } from '../../src/audit/audit.controller.js';
import { Person, bootApp, withDatabase, type TestApp } from './harness.js';

interface Listed {
  id: string;
  name: string;
  restricted: boolean;
  access: string;
}

/**
 * Collections, grants, the audit log and sample content, with one person per role:
 * Ada (owner), Kwame (admin), Tunde (member), Priya (viewer).
 */
describe.skipIf(withDatabase)('collections, access and the audit log', () => {
  let t: TestApp;
  let db: PrismaClient;
  const people = {} as Record<'ada' | 'kwame' | 'tunde' | 'priya', Person>;
  const ids = {} as Record<string, string>;
  let workspaceId: string;

  const names = async (who: Person) =>
    ((await who.get('/api/v1/collections').expect(200)).body as Listed[]).map(
      (c) => `${c.name}:${c.access}`,
    );

  beforeAll(async () => {
    t = await bootApp();
    db = createPrismaClient(t.databaseUrl);
    people.ada = new Person(t, 'ada@kestrel.example');
    await people.ada.signIn();
    await people.ada.patch('/api/v1/me', { name: 'Ada Okafor' }).expect(200);
    workspaceId = (
      await people.ada.post('/api/v1/workspaces', { name: 'Kestrel Labs' }).expect(201)
    ).body.id;

    for (const [key, role] of [
      ['kwame', 'admin'],
      ['tunde', 'member'],
      ['priya', 'viewer'],
    ] as const) {
      const email = `${key}@kestrel.example`;
      const invite = await people.ada.post('/api/v1/invites', { email, role }).expect(201);
      people[key] = new Person(t, email);
      await people[key].signIn();
      await people[key]
        .patch('/api/v1/me', { name: key[0]!.toUpperCase() + key.slice(1) })
        .expect(200);
      await people[key].post(`/api/v1/invites/${invite.body.id}/accept`).expect(200);
    }
    const { body } = await people.ada.get('/api/v1/members').expect(200);
    for (const m of body.members as { email: string; userId: string }[])
      ids[m.email.split('@')[0]!] = m.userId;
  });

  afterAll(async () => {
    await db?.$disconnect();
    await t?.close();
  });

  it('creates open and restricted collections', async () => {
    const product = await people.ada.post('/api/v1/collections', { name: 'Product' }).expect(201);
    expect(product.body).toMatchObject({ name: 'Product', restricted: false, access: 'manage' });
    const board = await people.ada
      .post('/api/v1/collections', { name: 'Board', restricted: true })
      .expect(201);
    ids.product = product.body.id;
    ids.board = board.body.id;
  });

  it('shows each person only what they may open, with their access', async () => {
    expect(await names(people.ada)).toEqual(['Board:manage', 'Product:manage']);
    expect(await names(people.kwame)).toEqual(['Board:manage', 'Product:manage']);
    expect(await names(people.tunde)).toEqual(['Product:edit']);
    expect(await names(people.priya)).toEqual(['Product:view']);
  });

  it('hides a restricted collection entirely from people without a grant', async () => {
    const res = await people.tunde
      .patch(`/api/v1/collections/${ids.board}`, { name: 'Peek' })
      .expect(404);
    expect(res.body.error.message).toBe('This collection doesn’t exist, or it’s private.');
  });

  it('lets members create and edit, but only managers delete', async () => {
    const viewer = await people.priya.post('/api/v1/collections', { name: 'Mine' }).expect(403);
    expect(viewer.body.error.message).toBe(
      'Viewers can’t make changes. Ask an admin to make you a member.',
    );

    await people.tunde
      .patch(`/api/v1/collections/${ids.product}`, { name: 'Product team' })
      .expect(200);
    const denied = await people.tunde.delete(`/api/v1/collections/${ids.product}`).expect(403);
    expect(denied.body.error.code).toBe('ACCESS_REQUIRED');

    const own = await people.tunde
      .post('/api/v1/collections', { name: 'Tunde’s notes' })
      .expect(201);
    expect(own.body.access).toBe('manage');
    await people.tunde.delete(`/api/v1/collections/${own.body.id}`).expect(204);
  });

  it('opens a restricted collection to a person, then to a role', async () => {
    const tunde = await people.ada
      .put(`/api/v1/collections/${ids.board}/permissions`, {
        restricted: true,
        grants: [{ userId: ids.tunde, access: 'view' }],
      })
      .expect(200);
    expect(tunde.body).toEqual({
      restricted: true,
      grants: [
        {
          userId: ids.tunde,
          role: null,
          access: 'view',
          user: { name: 'Tunde', email: 'tunde@kestrel.example' },
        },
      ],
    });
    expect(await names(people.tunde)).toEqual(['Board:view', 'Product team:edit']);
    expect(await names(people.priya)).toEqual(['Product team:view']);

    await people.kwame
      .put(`/api/v1/collections/${ids.board}/permissions`, {
        restricted: true,
        grants: [
          { userId: ids.tunde, access: 'edit' },
          { role: 'viewer', access: 'view' },
          { userId: ids.priya, access: 'manage' },
        ],
      })
      .expect(200);
    expect(await names(people.tunde)).toEqual(['Board:edit', 'Product team:edit']);
    // Viewers stay viewers, whatever a grant says.
    expect(await names(people.priya)).toEqual(['Board:view', 'Product team:view']);
  });

  it('keeps grants to admins and to real members of the workspace', async () => {
    await people.tunde.get(`/api/v1/collections/${ids.board}/permissions`).expect(403);
    await people.tunde
      .put(`/api/v1/collections/${ids.board}/permissions`, { restricted: false, grants: [] })
      .expect(403);

    const stranger = await people.ada
      .put(`/api/v1/collections/${ids.board}/permissions`, {
        restricted: true,
        grants: [{ userId: 'not-a-member', access: 'view' }],
      })
      .expect(400);
    expect(stranger.body.error.message).toBe('Grants can only name people in this workspace.');
    const twice = await people.ada
      .put(`/api/v1/collections/${ids.board}/permissions`, {
        restricted: true,
        grants: [
          { role: 'member', access: 'view' },
          { role: 'member', access: 'edit' },
        ],
      })
      .expect(400);
    expect(twice.body.error.message).toBe('Each person or role can appear only once.');
    const both = await people.ada
      .put(`/api/v1/collections/${ids.board}/permissions`, {
        restricted: true,
        grants: [{ userId: ids.tunde, role: 'member', access: 'view' }],
      })
      .expect(400);
    expect(both.body.error.message).toContain('Each grant names one person or one role.');
  });

  it('drops a removed member’s grants', async () => {
    const before = await db.collectionPermission.count({ where: { userId: ids.tunde } });
    expect(before).toBeGreaterThan(0);
    const { body } = await people.ada.get('/api/v1/members').expect(200);
    const membership = body.members.find(
      (m: { email: string }) => m.email === 'tunde@kestrel.example',
    );
    await people.ada.delete(`/api/v1/members/${membership.id}`).expect(204);
    expect(await db.collectionPermission.count({ where: { userId: ids.tunde } })).toBe(0);
  });

  it('never shows one workspace’s collections to another', async () => {
    const outsider = new Person(t, 'outsider@elsewhere.example');
    await outsider.signIn();
    await outsider.post('/api/v1/workspaces', { name: 'Elsewhere' }).expect(201);
    expect(await names(outsider)).toEqual([]);
    await outsider.patch(`/api/v1/collections/${ids.product}`, { name: 'Mine now' }).expect(404);
    await outsider.delete(`/api/v1/collections/${ids.product}`).expect(404);
    await outsider.get(`/api/v1/collections/${ids.board}/permissions`).expect(404);
  });

  it('loads the sample content for owners, once', async () => {
    const member = await people.kwame.post('/api/v1/onboarding/sample-content').expect(403);
    expect(member.body.error.message).toBe('Only owners can do this.');

    const first = await people.ada.post('/api/v1/onboarding/sample-content').expect(200);
    expect(Object.keys(first.body.collections).sort()).toEqual([
      'board',
      'customers',
      'handbook',
      'product',
    ]);
    const again = await people.ada.post('/api/v1/onboarding/sample-content').expect(200);
    expect(again.body).toEqual(first.body);

    expect((await people.ada.get('/api/v1/me')).body.workspace.sample).toBe(true);
    // "Board and finance" is restricted with no grants yet: only owners and admins see it.
    expect(await names(people.priya)).toEqual([
      'Board:view',
      'Customers:view',
      'Handbook:view',
      'Product:view',
      'Product team:view',
    ]);
    expect(await names(people.kwame)).toContain('Board and finance:manage');
  });

  it('lists the audit log newest first, filtered and paged, for admins', async () => {
    await people.priya.get('/api/v1/audit').expect(403);

    const all = await people.kwame.get('/api/v1/audit').expect(200);
    expect(all.body.entries[0]).toMatchObject({
      action: 'onboarding.sample_loaded',
      summary: 'Loaded the sample content',
      actor: { name: 'Ada Okafor', email: 'ada@kestrel.example' },
    });
    const summaries = (all.body.entries as { summary: string }[]).map((e) => e.summary);
    expect(summaries).toContain('Created the restricted collection “Board”');
    expect(summaries).toContain('Renamed the collection “Product” to “Product team”');
    expect(summaries).toContain('Restricted who can open “Board”');
    expect(summaries).toContain('Invited priya@kestrel.example as a viewer');
    expect(summaries).toContain('Removed Tunde from the workspace');

    const collections = await people.kwame.get('/api/v1/audit?action=collection').expect(200);
    expect(
      (collections.body.entries as { action: string }[]).every((e) =>
        e.action.startsWith('collection.'),
      ),
    ).toBe(true);

    const byTunde = await people.kwame.get(`/api/v1/audit?actor=${ids.tunde}`).expect(200);
    expect((byTunde.body.entries as { summary: string }[]).map((e) => e.summary)).toEqual([
      'Deleted the collection “Tunde’s notes”',
      'Created the collection “Tunde’s notes”',
      'Renamed the collection “Product” to “Product team”',
      'Joined as a member',
    ]);

    const first = await people.kwame.get('/api/v1/audit?limit=2').expect(200);
    expect(first.body.entries).toHaveLength(2);
    const second = await people.kwame
      .get(`/api/v1/audit?limit=2&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.entries[0].id).not.toBe(first.body.entries[1].id);
    expect(second.body.entries[0].at <= first.body.entries[1].at).toBe(true);

    const future = await people.kwame.get('/api/v1/audit?from=2999-01-01').expect(200);
    expect(future.body).toEqual({ entries: [], nextCursor: null });
    await people.kwame.get('/api/v1/audit?action=DROP TABLE').expect(400);
  });

  it('exports the audit log as CSV and logs the export', async () => {
    const res = await people.ada.get('/api/v1/audit.csv?action=member').expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="sotto-audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const text = res.text;
    expect(text.startsWith('﻿"Time (UTC)","Person","Email","Action","What happened"')).toBe(true);
    expect(text).toContain('"member.removed","Removed Tunde from the workspace"');

    const latest = await people.ada.get('/api/v1/audit?limit=1').expect(200);
    expect(latest.body.entries[0]).toMatchObject({
      action: 'audit.exported',
      summary: 'Exported the audit log',
    });
  });

  it('defuses spreadsheet formulas in CSV cells', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell(null)).toBe('""');
  });

  it('records the workspace id on every entry it writes', async () => {
    const stray = await db.auditLog.count({
      where: { NOT: { workspaceId }, actor: { email: 'ada@kestrel.example' } },
    });
    expect(stray).toBe(0);
  });
});
