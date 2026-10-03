import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CrossTenantWriteError, TENANT_MODELS, scopeArgs } from '../src/tenant.js';

const W = 'ws_a';

describe('scopeArgs', () => {
  it('adds the workspace to reads', () => {
    for (const op of ['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy']) {
      expect(scopeArgs('Collection', op, { where: { name: 'Product' } }, W)).toEqual({
        where: { name: 'Product', workspaceId: W },
      });
    }
    expect(scopeArgs('AuditLog', 'findMany', {}, W)).toEqual({ where: { workspaceId: W } });
  });

  it('overrides a workspace the caller put in the where', () => {
    expect(scopeArgs('Collection', 'findMany', { where: { workspaceId: 'ws_b' } }, W)).toEqual({
      where: { workspaceId: W },
    });
  });

  it('stamps creates, single and many', () => {
    expect(scopeArgs('Collection', 'create', { data: { name: 'Board' } }, W)).toEqual({
      data: { name: 'Board', workspaceId: W },
    });
    expect(
      scopeArgs('CollectionPermission', 'createMany', { data: [{ access: 'VIEW' }] }, W),
    ).toEqual({ data: [{ access: 'VIEW', workspaceId: W }] });
  });

  it('refuses writes into another workspace', () => {
    expect(() =>
      scopeArgs('Collection', 'create', { data: { name: 'x', workspaceId: 'ws_b' } }, W),
    ).toThrow(CrossTenantWriteError);
    expect(() =>
      scopeArgs('Collection', 'update', { where: { id: 'c1' }, data: { workspaceId: 'ws_b' } }, W),
    ).toThrow(CrossTenantWriteError);
    expect(() => scopeArgs('Workspace', 'create', { data: { name: 'x' } }, W)).toThrow(
      CrossTenantWriteError,
    );
  });

  it('scopes updates, deletes and upserts by workspace', () => {
    expect(
      scopeArgs('Membership', 'update', { where: { id: 'm1' }, data: { role: 'admin' } }, W),
    ).toEqual({ where: { id: 'm1', workspaceId: W }, data: { role: 'admin' } });
    expect(scopeArgs('Invite', 'deleteMany', { where: { email: 'a@b.c' } }, W)).toEqual({
      where: { email: 'a@b.c', workspaceId: W },
    });
    expect(
      scopeArgs(
        'CollectionPermission',
        'upsert',
        { where: { id: 'p1' }, create: { access: 'VIEW' }, update: { access: 'EDIT' } },
        W,
      ),
    ).toEqual({
      where: { id: 'p1', workspaceId: W },
      create: { access: 'VIEW', workspaceId: W },
      update: { access: 'EDIT' },
    });
  });

  it('narrows the Workspace model to the one workspace', () => {
    expect(scopeArgs('Workspace', 'findMany', {}, W)).toEqual({ where: { id: W } });
    expect(scopeArgs('Workspace', 'update', { where: { id: 'other' }, data: {} }, W)).toEqual({
      where: { id: W },
      data: {},
    });
  });

  it('leaves models outside the tenant alone', () => {
    const args = { where: { email: 'a@b.c' } };
    expect(scopeArgs('User', 'findFirst', args, W)).toBe(args);
  });
});

describe('TENANT_MODELS', () => {
  it('lists every model in schema.prisma that has a workspaceId field', () => {
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s+workspaceId\s/m.test(body!))
      .map(([, name]) => name);
    expect(models.sort()).toEqual([...TENANT_MODELS].sort());
  });
});
