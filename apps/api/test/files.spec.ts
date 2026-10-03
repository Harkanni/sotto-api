import { describe, expect, it } from 'vitest';
import type { Role } from '@sotto/db';
import {
  canDeleteForever,
  canRelabel,
  fileAccess,
  type FileForAccess,
} from '../src/files/access.js';
import { decodeCursor, encodeCursor } from '../src/files/files.service.js';
import { formatOf, titleFrom } from '../src/files/formats.js';
import { newFileId } from '../src/files/uploads.controller.js';

const viewer = (role: Role, userId = 'me') => ({ userId, role, workspaceId: 'w' });

const unfiled = (ownerId: string | null): FileForAccess => ({
  collectionId: null,
  ownerId,
  collection: null,
});
const inCollection = (
  restricted: boolean,
  grants: FileForAccess['collection'] extends infer C
    ? C extends { permissions: infer P }
      ? P
      : never
    : never = [],
): FileForAccess => ({
  collectionId: 'c',
  ownerId: 'someone',
  collection: { restricted, permissions: grants },
});

describe('file access (ADR 0016)', () => {
  it('admins and owners manage every file', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(fileAccess(viewer(role), unfiled('someone'))).toBe('MANAGE');
      expect(fileAccess(viewer(role), inCollection(true))).toBe('MANAGE');
    }
  });

  it('unfiled: members manage their own and view the rest; viewers only view', () => {
    expect(fileAccess(viewer('member'), unfiled('me'))).toBe('MANAGE');
    expect(fileAccess(viewer('member'), unfiled('someone'))).toBe('VIEW');
    expect(fileAccess(viewer('member'), unfiled(null))).toBe('VIEW');
    expect(fileAccess(viewer('viewer'), unfiled('me'))).toBe('VIEW');
  });

  it('in a collection: the collection decides', () => {
    expect(fileAccess(viewer('member'), inCollection(false))).toBe('EDIT');
    expect(fileAccess(viewer('viewer'), inCollection(false))).toBe('VIEW');
    expect(fileAccess(viewer('member'), inCollection(true))).toBeNull();
    expect(
      fileAccess(
        viewer('viewer'),
        inCollection(true, [{ userId: 'me', role: null, access: 'MANAGE' }]),
      ),
    ).toBe('VIEW');
    expect(
      fileAccess(
        viewer('member'),
        inCollection(true, [{ userId: null, role: 'member', access: 'MANAGE' }]),
      ),
    ).toBe('MANAGE');
  });

  it('deleting for good needs Manage, or being the owner with Edit', () => {
    const own = { ...inCollection(false), ownerId: 'me' };
    expect(canDeleteForever(viewer('member'), own, 'EDIT')).toBe(true);
    expect(canDeleteForever(viewer('member'), inCollection(false), 'EDIT')).toBe(false);
    expect(canDeleteForever(viewer('member'), inCollection(false), 'MANAGE')).toBe(true);
    expect(canDeleteForever(viewer('viewer'), own, 'VIEW')).toBe(false);
  });

  it('only admins lower a file from Restricted; anyone who edits may raise it', () => {
    expect(canRelabel(viewer('member'), 'INTERNAL', 'RESTRICTED')).toBe(true);
    expect(canRelabel(viewer('member'), 'RESTRICTED', 'INTERNAL')).toBe(false);
    expect(canRelabel(viewer('member'), 'RESTRICTED', 'CONFIDENTIAL')).toBe(false);
    expect(canRelabel(viewer('admin'), 'RESTRICTED', 'INTERNAL')).toBe(true);
    expect(canRelabel(viewer('member'), 'CONFIDENTIAL', 'INTERNAL')).toBe(true);
  });
});

describe('formats', () => {
  it('reads what the brief lists, by extension first', () => {
    expect(formatOf('Board pack.PDF')).toEqual({ kind: 'DOCUMENT', mime: 'application/pdf' });
    expect(formatOf('notes.md')?.kind).toBe('DOCUMENT');
    expect(formatOf('spec.docx')?.kind).toBe('DOCUMENT');
    expect(formatOf('standup.m4a')).toEqual({ kind: 'AUDIO', mime: 'audio/mp4' });
    expect(formatOf('call.webm', 'video/webm')?.mime).toBe('audio/webm');
  });

  it('falls back to the browser’s type for recordings without an extension', () => {
    expect(formatOf('recording', 'audio/webm;codecs=opus')).toEqual({
      kind: 'AUDIO',
      mime: 'audio/webm',
    });
    expect(formatOf('recording', 'video/mp4')).toEqual({ kind: 'AUDIO', mime: 'audio/mp4' });
  });

  it('refuses what it can’t read', () => {
    expect(formatOf('slides.pptx')).toBeNull();
    expect(formatOf('archive.zip', 'application/zip')).toBeNull();
    expect(formatOf('old.doc')).toBeNull();
  });

  it('makes a title from the name', () => {
    expect(titleFrom('Q3_board_pack.pdf')).toBe('Q3 board pack');
    expect(titleFrom('.pdf')).toBe('Untitled');
    expect(titleFrom(`${'x'.repeat(200)}.txt`)).toHaveLength(120);
  });
});

describe('ids and cursors', () => {
  it('makes unguessable, storage-safe file ids', () => {
    const ids = new Set(Array.from({ length: 500 }, newFileId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]{19}$/);
  });

  it('round-trips cursors and rejects tampered ones', () => {
    const c = { k: '2026-10-03T10:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('not-a-cursor')).toThrow(/out of date/);
  });
});
