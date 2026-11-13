import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LibraryService, LibraryServiceError } from '../../src/worker/library-service';
import { encodeLinkedVirtualFolderId } from '../../src/shared/linked-folder-tree';
import { collectPrivacyGuardedAssetIds } from '../../src/worker/folder-privacy-fence';
import {
  FolderPrivacyStateStore,
  collectLockedRoots,
  folderPrivacyTableExists,
  privacyHiddenAssetsSql,
  readProtectedRoots,
} from '../../src/worker/folder-privacy';
import { importNoConflict } from './import-no-conflict';

const VALID_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-privacy-test-'));
  temporaryRoots.push(root);
  return root;
}

function expectServiceCode(operation: () => unknown, code: LibraryServiceError['code']): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LibraryServiceError);
  expect((thrown as LibraryServiceError).code).toBe(code);
}

function writePng(directory: string, name: string): string {
  const file = path.join(directory, name);
  writeFileSync(file, VALID_1X1_PNG);
  return file;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('folder privacy: configuration lifecycle', () => {
  it('protects, unlocks, re-locks, changes password and removes a managed scope', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Privacy', selectedParentPath: root });
    const privateFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Private' });

    // Nothing protected initially.
    expect(service.folderPrivacy({ libraryId: library.libraryId, action: 'status' }).states).toEqual([]);

    const afterProtect = service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: privateFolder.folderId,
      action: 'protect',
      password: 'correct horse',
    });
    expect(afterProtect.states).toEqual([{ folderId: privateFolder.folderId, locked: true }]);

    // Protecting an already-protected scope is rejected.
    expectServiceCode(
      () =>
        service.folderPrivacy({
          libraryId: library.libraryId,
          folderId: privateFolder.folderId,
          action: 'protect',
          password: 'other',
        }),
      'FOLDER_PRIVACY_INVALID_ACTION',
    );

    // Wrong password cannot unlock.
    expectServiceCode(
      () =>
        service.folderPrivacy({
          libraryId: library.libraryId,
          folderId: privateFolder.folderId,
          action: 'unlock',
          password: 'wrong',
        }),
      'FOLDER_PRIVACY_PASSWORD_INVALID',
    );
    expect(service.folderPrivacy({ libraryId: library.libraryId, action: 'status' }).states).toEqual([
      { folderId: privateFolder.folderId, locked: true },
    ]);

    // Correct password unlocks.
    const afterUnlock = service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: privateFolder.folderId,
      action: 'unlock',
      password: 'correct horse',
    });
    expect(afterUnlock.states).toEqual([{ folderId: privateFolder.folderId, locked: false }]);

    // Lock is a free memory operation, no password required.
    const afterLock = service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: privateFolder.folderId,
      action: 'lock',
    });
    expect(afterLock.states).toEqual([{ folderId: privateFolder.folderId, locked: true }]);

    // Change password requires old + new; re-locks.
    expectServiceCode(
      () =>
        service.folderPrivacy({
          libraryId: library.libraryId,
          folderId: privateFolder.folderId,
          action: 'change-password',
          password: 'correct horse',
          newPassword: '',
        }),
      'FOLDER_PRIVACY_PASSWORD_REQUIRED',
    );
    const afterChange = service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: privateFolder.folderId,
      action: 'change-password',
      password: 'correct horse',
      newPassword: 'new secret',
    });
    expect(afterChange.states).toEqual([{ folderId: privateFolder.folderId, locked: true }]);
    // Old password no longer works; new one does.
    expectServiceCode(
      () =>
        service.folderPrivacy({
          libraryId: library.libraryId,
          folderId: privateFolder.folderId,
          action: 'unlock',
          password: 'correct horse',
        }),
      'FOLDER_PRIVACY_PASSWORD_INVALID',
    );
    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: privateFolder.folderId,
      action: 'unlock',
      password: 'new secret',
    });

    // Remove requires the password even when unlocked.
    expectServiceCode(
      () =>
        service.folderPrivacy({
          libraryId: library.libraryId,
          folderId: privateFolder.folderId,
          action: 'remove',
          password: 'wrong',
        }),
      'FOLDER_PRIVACY_PASSWORD_INVALID',
    );
    const afterRemove = service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: privateFolder.folderId,
      action: 'remove',
      password: 'new secret',
    });
    expect(afterRemove.states).toEqual([]);

    // Removing an unprotected scope is an invalid action.
    expectServiceCode(
      () =>
        service.folderPrivacy({
          libraryId: library.libraryId,
          folderId: privateFolder.folderId,
          action: 'remove',
          password: 'new secret',
        }),
      'FOLDER_PRIVACY_INVALID_ACTION',
    );

    service.closeAll();
  });

  it('requires a password argument and rejects unknown scopes', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'PrivacyRules', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'F' });

    expectServiceCode(
      () => service.folderPrivacy({ libraryId: library.libraryId, folderId: folder.folderId, action: 'protect' }),
      'FOLDER_PRIVACY_PASSWORD_REQUIRED',
    );
    expectServiceCode(
      () =>
        service.folderPrivacy({
          libraryId: library.libraryId,
          folderId: 'does-not-exist',
          action: 'protect',
          password: 'x',
        }),
      'INVALID_SELECTION',
    );
    service.closeAll();
  });

  it('re-locks every protected root after the library is reopened (restart)', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Restart', selectedParentPath: root });
    const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: folder.folderId,
      action: 'protect',
      password: 'pw',
    });
    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: folder.folderId,
      action: 'unlock',
      password: 'pw',
    });
    expect(service.folderPrivacy({ libraryId: library.libraryId, action: 'status' }).states).toEqual([
      { folderId: folder.folderId, locked: false },
    ]);

    // Simulate worker restart: closing and reopening the library clears memory unlock state.
    const libraryPath = library.libraryPath;
    service.closeLibrary(library.libraryId);
    service.openLibrary(libraryPath);
    expect(service.folderPrivacy({ libraryId: library.libraryId, action: 'status' }).states).toEqual([
      { folderId: folder.folderId, locked: true },
    ]);
    service.closeAll();
  });
});
describe('folder privacy: read/write enforcement with recursive inheritance', () => {
  it('hides descendants of a locked managed root in browse, list and search (showIgnored never bypasses)', async () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Enforce', selectedParentPath: root });
    const parent = service.createManagedFolder({ libraryId: library.libraryId, name: 'Archive' });
    const child = service.createManagedFolder({ libraryId: library.libraryId, parentFolderId: parent.folderId, name: 'Deep' });
    const outside = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });

    const publicFile = writePng(root, 'public.png');
    const insideFile = writePng(root, 'secret.png');
    importNoConflict(service, library.libraryId, publicFile, outside.folderId);
    importNoConflict(service, library.libraryId, insideFile, child.folderId);

    // Before protection the protected subtree is visible.
    const before = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(before.length).toBe(2);

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: parent.folderId,
      action: 'protect',
      password: 'pw',
    });

    // Recursive list hides the descendant asset; public stays visible.
    for (const showIgnored of [false, true]) {
      const visible = service.listAssets({ libraryId: library.libraryId, recursive: true, showIgnored });
      expect(visible.length).toBe(1);
      expect(visible[0]!.displayName).toContain('public');
    }

    // Global search never leaks the locked subtree, with or without showIgnored.
    for (const showIgnored of [false, true]) {
      const page = service.searchAssets({ libraryId: library.libraryId, showIgnored });
      expect(page.items.length).toBe(1);
    }

    // Browsing the locked root itself is denied (FOLDER_LOCKED).
    await expect(
      service.listFolderBrowseEntriesAsync({ libraryId: library.libraryId, parentFolderId: parent.folderId }),
    ).rejects.toMatchObject({ code: 'FOLDER_LOCKED' });

    // Browsing the grandchild (inside the locked root) is also denied.
    await expect(
      service.listFolderBrowseEntriesAsync({ libraryId: library.libraryId, parentFolderId: child.folderId }),
    ).rejects.toMatchObject({ code: 'FOLDER_LOCKED' });

    // Browsing a public folder still works.
    const publicBrowse = await service.listFolderBrowseEntriesAsync({
      libraryId: library.libraryId,
      parentFolderId: outside.folderId,
    });
    expect(publicBrowse.length).toBeGreaterThanOrEqual(0);

    // Manager listing hides descendant folder rows but keeps the locked root visible.
    const folders = service.listManagedFolders(library.libraryId);
    const folderIds = folders.map((f) => f.folderId);
    expect(folderIds).toContain(parent.folderId);
    expect(folderIds).not.toContain(child.folderId);
    expect(folderIds).toContain(outside.folderId);

    service.closeAll();
  });

  it('treats names containing LIKE metacharacters literally in the privacy predicate', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Wildcard', selectedParentPath: root });
    // A folder name with % and _ would over-match if the privacy prefix used unescaped LIKE.
    const locked = service.createManagedFolder({ libraryId: library.libraryId, name: '50%_off' });
    // A sibling whose name merely starts the same way should NOT be hidden.
    const sibling = service.createManagedFolder({ libraryId: library.libraryId, name: '50 percent' });

    const inLocked = writePng(root, 'a.png');
    const inSibling = writePng(root, 'b.png');
    importNoConflict(service, library.libraryId, inLocked, locked.folderId);
    importNoConflict(service, library.libraryId, inSibling, sibling.folderId);

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: locked.folderId,
      action: 'protect',
      password: 'pw',
    });

    const visible = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(visible.length).toBe(1);
    expect(visible[0]!.managedFolderId).toBe(sibling.folderId);
    service.closeAll();
  });

  it('rejects moves and trash of assets inside a locked root', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Writes', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const target = service.createManagedFolder({ libraryId: library.libraryId, name: 'Target' });

    const file = writePng(root, 'v.png');
    importNoConflict(service, library.libraryId, file, vault.folderId);
    const asset = service
      .listAssets({ libraryId: library.libraryId, folderId: vault.folderId, recursive: false })[0]!;

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'protect',
      password: 'pw',
    });

    expectServiceCode(
      () =>
        service.moveAssets({
          libraryId: library.libraryId,
          assetIds: [asset.assetId],
          targetFolderId: target.folderId,
          conflictStrategy: 'keep-both',
        }),
      'FOLDER_LOCKED',
    );
    expectServiceCode(
      () => service.trashAssets({ libraryId: library.libraryId, assetIds: [asset.assetId] }),
      'FOLDER_LOCKED',
    );

    // Mutating the folder itself (rename) is also rejected while locked.
    expectServiceCode(
      () =>
        service.renameManagedFolder({
          libraryId: library.libraryId,
          folderId: vault.folderId,
          newName: 'Renamed',
        }),
      'FOLDER_LOCKED',
    );
    service.closeAll();
  });

  it('denies media-source authorization for a locked asset', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Media', selectedParentPath: root });
    const secret = service.createManagedFolder({ libraryId: library.libraryId, name: 'SecretZone' });
    const file = writePng(root, 'm.png');
    importNoConflict(service, library.libraryId, file, secret.folderId);
    const asset = service
      .listAssets({ libraryId: library.libraryId, folderId: secret.folderId, recursive: false })[0]!;

    // Media source resolvable before protection.
    expect(() =>
      service.getCurrentMediaSource(library.libraryId, asset.assetId, asset.currentRevisionId),
    ).not.toThrow();

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: secret.folderId,
      action: 'protect',
      password: 'pw',
    });

    expectServiceCode(
      () => service.getCurrentMediaSource(library.libraryId, asset.assetId, asset.currentRevisionId),
      'FOLDER_LOCKED',
    );
    service.closeAll();
  });

  it('denies extension imports into any protected target (locked or unlocked)', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Ext', selectedParentPath: root });
    const target = service.createManagedFolder({ libraryId: library.libraryId, name: 'Ingest' });

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: target.folderId,
      action: 'protect',
      password: 'pw',
    });
    // Even after unlocking, the extension may not write into a protected scope.
    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: target.folderId,
      action: 'unlock',
      password: 'pw',
    });

    expectServiceCode(
      () => service.assertExtensionImportTargetAllowed(library.libraryId, target.folderId),
      'FOLDER_LOCKED',
    );
    // A plain managed folder is allowed.
    const plain = service.createManagedFolder({ libraryId: library.libraryId, name: 'Plain' });
    expect(() => service.assertExtensionImportTargetAllowed(library.libraryId, plain.folderId)).not.toThrow();
    service.closeAll();
  });

  it('enforces privacy across linked folder trees', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Linked', selectedParentPath: root });
    const sourceRoot = path.join(root, 'ext');
    mkdirSync(sourceRoot);
    writeFileSync(path.join(sourceRoot, 'top.txt'), 'top');
    mkdirSync(path.join(sourceRoot, 'nested'));
    writeFileSync(path.join(sourceRoot, 'nested', 'inner.txt'), 'inner');

    const linked = service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: sourceRoot,
    });
    expect(linked.assetCount).toBe(2);

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: linked.folderId,
      action: 'protect',
      password: 'pw',
    });

    const visible = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(visible.length).toBe(0);
    const page = service.searchAssets({ libraryId: library.libraryId, showIgnored: true });
    expect(page.items.length).toBe(0);
    service.closeAll();
  });
});

describe('folder privacy: Worker dispatch fence and stale id lists', () => {
  it('collects only exact assetId/assetIds fields, including nested and array shapes', () => {
    expect(collectPrivacyGuardedAssetIds({
      type: 'asset.metadata.update',
      libraryId: 'lib',
      assetId: 'a1',
      assetIds: ['a2', 'a3', 'a2'],
      folderIds: ['f1'],
      tagIds: ['t1'],
      revisionId: 'r1',
      nested: { assetId: 'a4', collectionIds: ['c1'] },
      list: [{ assetIds: ['a5'] }, { assetId: 42 }],
      malformed: { assetIds: 'not-an-array' },
    })).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);

    // Unrelated ids and non-string values must never be treated as assets.
    expect(collectPrivacyGuardedAssetIds({ libraryId: 'lib', folderIds: ['f'], assetId: 7 })).toEqual([]);
    expect(collectPrivacyGuardedAssetIds({ assetIds: [1, null, 'ok'] })).toEqual(['ok']);
    expect(collectPrivacyGuardedAssetIds(null)).toEqual([]);
    expect(collectPrivacyGuardedAssetIds('a-string')).toEqual([]);

    // Depth cap bounds malformed / cyclic-shaped input instead of walking forever.
    let deep: Record<string, unknown> = { assetId: 'too-deep' };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(collectPrivacyGuardedAssetIds(deep)).toEqual([]);
  });

  it('denies dispatch-fenced asset ids only while a root is locked', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Fence', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const file = writePng(root, 'f.png');
    importNoConflict(service, library.libraryId, file, vault.folderId);
    const asset = service
      .listAssets({ libraryId: library.libraryId, folderId: vault.folderId, recursive: false })[0]!;

    // No locked root => any id list (including unknown ids) is allowed.
    expect(() => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, [asset.assetId])).not.toThrow();
    expect(() => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, [])).not.toThrow();

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'protect',
      password: 'pw',
    });

    expectServiceCode(
      () => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, [asset.assetId]),
      'FOLDER_LOCKED',
    );
    // One protected id in a mixed batch denies the whole request.
    expectServiceCode(
      () => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, ['unknown-id', asset.assetId]),
      'FOLDER_LOCKED',
    );
    // Unknown / empty ids do not trip the fence.
    expect(() => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, ['unknown-id'])).not.toThrow();
    expect(() => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, [])).not.toThrow();

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'unlock',
      password: 'pw',
    });
    expect(() => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, [asset.assetId])).not.toThrow();

    // A closed library is a no-op: dispatch cannot target it anyway.
    service.closeLibrary(library.libraryId);
    expect(() => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, [asset.assetId])).not.toThrow();
    service.closeAll();
  });

  it('re-applies privacy to a BrowseSession id list captured before the lock (rows AND total)', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Session', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const publicFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });
    importNoConflict(service, library.libraryId, writePng(root, 'inside.png'), vault.folderId);
    importNoConflict(service, library.libraryId, writePng(root, 'outside.png'), publicFolder.folderId);
    const inside = service
      .listAssets({ libraryId: library.libraryId, folderId: vault.folderId, recursive: false })[0]!;
    const outside = service
      .listAssets({ libraryId: library.libraryId, folderId: publicFolder.folderId, recursive: false })[0]!;

    // A BrowseSession is an ordered id list built while everything was visible.
    const sessionIds = [inside.assetId, outside.assetId];
    const before = service.searchAssets({ libraryId: library.libraryId, sessionAssetIds: sessionIds, limit: 50 });
    expect(before.items.map((item) => item.assetId).sort()).toEqual([...sessionIds].sort());
    expect(before.total).toBe(2);

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'protect',
      password: 'pw',
    });

    // Ordinary search is the control: one visible row and a matching total.
    const ordinary = service.searchAssets({ libraryId: library.libraryId, limit: 50 });
    expect(ordinary.items.map((item) => item.assetId)).toEqual([outside.assetId]);
    expect(ordinary.total).toBe(1);

    // The stale session list must not keep serving locked rows or reporting their count.
    const after = service.searchAssets({ libraryId: library.libraryId, sessionAssetIds: sessionIds, limit: 50 });
    expect(after.items.map((item) => item.assetId)).toEqual([outside.assetId]);
    expect(after.total).toBe(1);

    // Unlocking makes the same stale list valid again without rebuilding it.
    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'unlock',
      password: 'pw',
    });
    const unlocked = service.searchAssets({ libraryId: library.libraryId, sessionAssetIds: sessionIds, limit: 50 });
    expect(unlocked.total).toBe(2);
    service.closeAll();
  });

  it('blocks hard-delete of a locked folder through both sync and async entry points', async () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'HardDelete', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    importNoConflict(service, library.libraryId, writePng(root, 'h.png'), vault.folderId);

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'protect',
      password: 'pw',
    });

    expectServiceCode(
      () => service.deleteManagedFolderFromDisk({ libraryId: library.libraryId, folderId: vault.folderId }),
      'FOLDER_LOCKED',
    );
    await expect(
      service.deleteManagedFolderFromDiskAsync({ libraryId: library.libraryId, folderId: vault.folderId }),
    ).rejects.toMatchObject({ code: 'FOLDER_LOCKED' });

    // Nothing was destroyed by the rejected deletes.
    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'unlock',
      password: 'pw',
    });
    expect(service.listAssets({ libraryId: library.libraryId, folderId: vault.folderId, recursive: false }).length).toBe(1);
    expect(service.listManagedFolders(library.libraryId).map((folder) => folder.folderId)).toContain(vault.folderId);
    service.closeAll();
  });
});

describe('folder privacy: inherited scopes, badges, exports and schema tolerance', () => {
  it('inherits a locked managed ancestor into a linked root mounted beneath it', async () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'NestedLinked', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const publicFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });

    const sourceRoot = path.join(root, 'ext');
    mkdirSync(path.join(sourceRoot, 'sub'), { recursive: true });
    writePng(sourceRoot, 'top.png');
    writePng(path.join(sourceRoot, 'sub'), 'inner.png');
    const linked = service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: sourceRoot,
      parentFolderId: vault.folderId,
    });
    importNoConflict(service, library.libraryId, writePng(root, 'outside.png'), publicFolder.folderId);
    const beforeAssets = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(beforeAssets.length).toBe(3);
    const linkedAssetIds = beforeAssets
      .filter((asset) => asset.locationKind === 'linked')
      .map((asset) => asset.assetId);
    expect(linkedAssetIds.length).toBe(2);

    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'protect',
      password: 'vault-pw',
    });

    // The linked assets are location_kind='linked', so a managed-only predicate
    // would leak them. Both the managed and nested linked subtrees are hidden.
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(1);
    expect(service.searchAssets({ libraryId: library.libraryId, showIgnored: true }).items.length).toBe(1);
    expectServiceCode(
      () => service.assertRequestAssetsNotPrivacyLocked(library.libraryId, linkedAssetIds),
      'FOLDER_LOCKED',
    );

    // Browsing the nested linked scope is denied while the ancestor is locked.
    await expect(
      service.listFolderBrowseEntriesAsync({
        libraryId: library.libraryId,
        parentFolderId: linked.folderId,
      }),
    ).rejects.toMatchObject({ code: 'FOLDER_LOCKED' });

    // Extension saves MUST be denied even after the ancestor is unlocked.
    service.folderPrivacy({
      libraryId: library.libraryId,
      folderId: vault.folderId,
      action: 'unlock',
      password: 'vault-pw',
    });
    expectServiceCode(
      () => service.assertExtensionImportTargetAllowed(library.libraryId, linked.folderId),
      'FOLDER_LOCKED',
    );
    // Unlocking really does restore the inherited assets (no silent partial lock).
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(3);
    service.closeAll();
  });

  it('protects sibling linked virtual directories independently with distinct passwords', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Virtual', selectedParentPath: root });
    const sourceRoot = path.join(root, 'ext');
    mkdirSync(path.join(sourceRoot, 'alpha'), { recursive: true });
    mkdirSync(path.join(sourceRoot, 'beta'), { recursive: true });
    writePng(path.join(sourceRoot, 'alpha'), 'alpha.png');
    writePng(path.join(sourceRoot, 'beta'), 'beta.png');
    const linked = service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: sourceRoot,
    });
    expect(linked.assetCount).toBe(2);

    const alphaId = encodeLinkedVirtualFolderId(linked.folderId, 'alpha');
    const betaId = encodeLinkedVirtualFolderId(linked.folderId, 'beta');
    service.folderPrivacy({ libraryId: library.libraryId, folderId: alphaId, action: 'protect', password: 'alpha-pw' });
    service.folderPrivacy({ libraryId: library.libraryId, folderId: betaId, action: 'protect', password: 'beta-pw' });

    // Two independent scope ids, not one collision on the linked root id.
    const states = service.folderPrivacy({ libraryId: library.libraryId, action: 'status' }).states;
    expect(states.map((state) => state.folderId).sort()).toEqual([alphaId, betaId].sort());
    expect(states.every((state) => state.locked)).toBe(true);
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(0);

    // Each sibling keeps its OWN password.
    expectServiceCode(
      () => service.folderPrivacy({ libraryId: library.libraryId, folderId: alphaId, action: 'unlock', password: 'beta-pw' }),
      'FOLDER_PRIVACY_PASSWORD_INVALID',
    );
    service.folderPrivacy({ libraryId: library.libraryId, folderId: alphaId, action: 'unlock', password: 'alpha-pw' });
    const visible = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(visible.length).toBe(1);
    expect(visible[0]!.displayName).toContain('alpha');
    expect(service.folderPrivacy({ libraryId: library.libraryId, action: 'status' }).states).toEqual([
      { folderId: alphaId, locked: false },
      { folderId: betaId, locked: true },
    ]);
    service.closeAll();
  });

  it('refuses to unlock a child scope while a covering ancestor is still locked', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'InheritedUnlock', selectedParentPath: root });
    const parent = service.createManagedFolder({ libraryId: library.libraryId, name: 'Parent' });
    const child = service.createManagedFolder({ libraryId: library.libraryId, parentFolderId: parent.folderId, name: 'Child' });
    importNoConflict(service, library.libraryId, writePng(root, 'child.png'), child.folderId);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: parent.folderId, action: 'protect', password: 'parent-pw' });
    service.folderPrivacy({ libraryId: library.libraryId, folderId: child.folderId, action: 'protect', password: 'child-pw' });

    // Unlocking the child must not reveal assets the parent still protects.
    expectServiceCode(
      () => service.folderPrivacy({ libraryId: library.libraryId, folderId: child.folderId, action: 'unlock', password: 'child-pw' }),
      'FOLDER_LOCKED',
    );
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(0);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: parent.folderId, action: 'unlock', password: 'parent-pw' });
    service.folderPrivacy({ libraryId: library.libraryId, folderId: child.folderId, action: 'unlock', password: 'child-pw' });
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(1);
    service.closeAll();
  });

  it('publishes privacy badges and zeroes locked folder counts, child counts and covers', async () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Badges', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const child = service.createManagedFolder({ libraryId: library.libraryId, parentFolderId: vault.folderId, name: 'Deep' });
    const publicFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });
    importNoConflict(service, library.libraryId, writePng(root, 'vault.png'), child.folderId);
    importNoConflict(service, library.libraryId, writePng(root, 'public.png'), publicFolder.folderId);

    const before = service.listManagedFolders(library.libraryId).find((f) => f.folderId === vault.folderId)!;
    expect(before.privacy).toBeUndefined();
    expect(before.childFolderCount).toBe(1);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });

    const after = service.listManagedFolders(library.libraryId).find((f) => f.folderId === vault.folderId)!;
    expect(after.privacy).toEqual({ protected: true, locked: true });
    expect(after.directAssetCount).toBe(0);
    expect(after.childFolderCount).toBe(0);

    const entries = await service.folderEntriesByRefsAsync({
      libraryId: library.libraryId,
      refs: [
        { locationKind: 'managed', folderId: vault.folderId },
        { locationKind: 'managed', folderId: publicFolder.folderId },
      ],
    });
    const vaultEntry = entries.find((entry) => entry.folderId === vault.folderId)!;
    expect(vaultEntry.privacy).toEqual({ protected: true, locked: true });
    expect(vaultEntry.directAssetCount).toBe(0);
    expect(vaultEntry.recursiveAssetCount).toBe(0);
    expect(vaultEntry.childFolderCount).toBe(0);
    expect(vaultEntry.coverArtifactIds).toEqual([]);
    expect(vaultEntry.coverAssetIds).toEqual([]);
    expect(entries.find((entry) => entry.folderId === publicFolder.folderId)!.privacy).toBeUndefined();

    // Unlocked protection still reports a badge (protected, not locked).
    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'unlock', password: 'pw' });
    const unlocked = service.listManagedFolders(library.libraryId).find((f) => f.folderId === vault.folderId)!;
    expect(unlocked.privacy).toEqual({ protected: true, locked: false });
    service.closeAll();
  });

  it('publishes privacy badges and zero counts on linked roots and virtual children', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'LinkedBadges', selectedParentPath: root });
    const sourceRoot = path.join(root, 'ext');
    mkdirSync(path.join(sourceRoot, 'sub'), { recursive: true });
    writePng(sourceRoot, 'top.png');
    writePng(path.join(sourceRoot, 'sub'), 'inner.png');
    const linked = service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: sourceRoot });

    service.folderPrivacy({ libraryId: library.libraryId, folderId: linked.folderId, action: 'protect', password: 'pw' });
    const summaries = service.listLinkedFolders(library.libraryId);
    const rootSummary = summaries.find((summary) => summary.folderId === linked.folderId)!;
    expect(rootSummary.privacy).toEqual({ protected: true, locked: true });
    expect(rootSummary.assetCount).toBe(0);
    const childId = encodeLinkedVirtualFolderId(linked.folderId, 'sub');
    const childSummary = summaries.find((summary) => summary.folderId === childId)!;
    expect(childSummary.privacy).toEqual({ protected: true, locked: true });
    expect(childSummary.assetCount).toBe(0);
    service.closeAll();
  });

  it('rejects whole-library exports while any root is locked and creates no output', async () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Export', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    importNoConflict(service, library.libraryId, writePng(root, 'e.png'), vault.folderId);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });

    const destinationFolder = path.join(root, 'export-dir');
    await expect(
      service.exportLibraryToFolder({
        libraryId: library.libraryId,
        destinationPath: destinationFolder,
        includeLinkedContent: false,
      }),
    ).rejects.toMatchObject({ code: 'FOLDER_LOCKED' });
    expect(existsSync(destinationFolder)).toBe(false);

    const destinationZip = path.join(root, 'export.zip');
    await expect(
      service.exportLibraryToZip({
        libraryId: library.libraryId,
        destinationPath: destinationZip,
        includeLinkedContent: false,
      }),
    ).rejects.toMatchObject({ code: 'FOLDER_LOCKED' });
    expect(existsSync(destinationZip)).toBe(false);

    // A whole-library export IS allowed once the user unlocks everything.
    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'unlock', password: 'pw' });
    await service.exportLibraryToFolder({
      libraryId: library.libraryId,
      destinationPath: destinationFolder,
      includeLinkedContent: false,
    });
    expect(existsSync(destinationFolder)).toBe(true);
    service.closeAll();
  });

  it('denies folder-scope-only commands (cover, path and empty-folder hard-delete)', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'ScopeCommands', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    importNoConflict(service, library.libraryId, writePng(root, 's.png'), vault.folderId);

    expect(() => service.resolveFolderCustomCover({ libraryId: library.libraryId, folderId: vault.folderId })).not.toThrow();
    expect(() => service.resolveFolderPath(library.libraryId, vault.folderId)).not.toThrow();

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });

    expectServiceCode(
      () => service.resolveFolderCustomCover({ libraryId: library.libraryId, folderId: vault.folderId }),
      'FOLDER_LOCKED',
    );
    expectServiceCode(
      () => service.resolveFolderPath(library.libraryId, vault.folderId),
      'FOLDER_LOCKED',
    );
    expectServiceCode(
      () => service.deleteEmptyManagedFolders({ libraryId: library.libraryId, folderIds: [vault.folderId] }),
      'FOLDER_LOCKED',
    );
    // Nothing was deleted by the rejected hard-delete.
    expect(service.listManagedFolders(library.libraryId).map((f) => f.folderId)).toContain(vault.folderId);
    service.closeAll();
  });

  it('treats a missing privacy table as unprotected instead of throwing on open/inspect', () => {
    // A pre-v61 / partial-migration library has no protection rows, so there is
    // nothing to leak. Read paths must never throw "no such table".
    const connection = {
      prepare: (sql: string) => ({
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: () => { throw new Error('SqliteError: no such table: folder_privacy ' + sql); },
      }),
    };
    expect(folderPrivacyTableExists(connection)).toBe(false);
    expect(readProtectedRoots(connection, 'lib')).toEqual([]);
    expect(collectLockedRoots(connection, 'lib', new FolderPrivacyStateStore())).toEqual([]);
    expect(privacyHiddenAssetsSql(connection, 'lib', new FolderPrivacyStateStore())).toEqual({
      sql: '1 = 1',
      params: [],
    });
  });

  it('hides locked assets from collection listings and MCP-visible counts', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'Collections', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const publicFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });
    importNoConflict(service, library.libraryId, writePng(root, 'vault-c.png'), vault.folderId);
    importNoConflict(service, library.libraryId, writePng(root, 'public-c.png'), publicFolder.folderId);
    const assetIds = service
      .listAssets({ libraryId: library.libraryId, recursive: true })
      .map((asset) => asset.assetId);
    expect(assetIds.length).toBe(2);

    const collection = service.createCollection({ libraryId: library.libraryId, name: 'Mixed' });
    service.addCollectionAssets({ libraryId: library.libraryId, collectionId: collection.collectionId, assetIds });

    // Populate the cached recursive counts BEFORE the lock: a privacy change
    // must invalidate them, not just filter the SQL on a cold cache.
    expect(service.listCollectionAssets({
      libraryId: library.libraryId,
      collectionId: collection.collectionId,
      recursive: false,
    }).length).toBe(2);
    expect(service.listCollections(library.libraryId).find((c) => c.collectionId === collection.collectionId)?.assetCount).toBe(2);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });

    const visible = service.listCollectionAssets({
      libraryId: library.libraryId,
      collectionId: collection.collectionId,
      recursive: false,
    });
    expect(visible.length).toBe(1);
    expect(service.listCollections(library.libraryId).find((c) => c.collectionId === collection.collectionId)?.assetCount).toBe(1);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'unlock', password: 'pw' });
    expect(service.listCollectionAssets({
      libraryId: library.libraryId,
      collectionId: collection.collectionId,
      recursive: false,
    }).length).toBe(2);
    expect(service.listCollections(library.libraryId).find((c) => c.collectionId === collection.collectionId)?.assetCount).toBe(2);
    service.closeAll();
  });

  it('applies the privacy predicate to recursive collection counts', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'RecursiveCollections', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const publicFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });
    importNoConflict(service, library.libraryId, writePng(root, 'vault-r.png'), vault.folderId);
    importNoConflict(service, library.libraryId, writePng(root, 'public-r.png'), publicFolder.folderId);
    const assets = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(assets.length).toBe(2);
    const vaultAssetId = assets.find((a) => a.displayName.includes('vault-r'))!.assetId;
    const publicAssetId = assets.find((a) => a.displayName.includes('public-r'))!.assetId;

    const parent = service.createCollection({ libraryId: library.libraryId, name: 'Parent' });
    const child = service.createCollection({ libraryId: library.libraryId, parentId: parent.collectionId, name: 'Child' });
    service.addCollectionAssets({ libraryId: library.libraryId, collectionId: parent.collectionId, assetIds: [publicAssetId] });
    service.addCollectionAssets({ libraryId: library.libraryId, collectionId: child.collectionId, assetIds: [vaultAssetId] });

    const counts = () => new Map(service.listCollections(library.libraryId).map((c) => [c.collectionId, c.assetCount]));
    expect(counts().get(parent.collectionId)).toBe(2);
    expect(counts().get(child.collectionId)).toBe(1);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });
    expect(counts().get(parent.collectionId)).toBe(1);
    expect(counts().get(child.collectionId)).toBe(0);
    expect(service.listCollectionAssets({
      libraryId: library.libraryId,
      collectionId: parent.collectionId,
      recursive: true,
    }).map((a) => a.assetId)).toEqual([publicAssetId]);
    service.closeAll();
  });

});

describe('folder privacy: MCP read surfaces, central source guards and rename identity', () => {
  it('hides locked assets from trash listings using the pre-trash original path', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'TrashPrivacy', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const publicFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });
    importNoConflict(service, library.libraryId, writePng(root, 'vault-t.png'), vault.folderId);
    importNoConflict(service, library.libraryId, writePng(root, 'public-t.png'), publicFolder.folderId);
    const assets = service.listAssets({ libraryId: library.libraryId, recursive: true });
    const vaultAssetId = assets.find((asset) => asset.displayName.includes('vault-t'))!.assetId;
    const publicAssetId = assets.find((asset) => asset.displayName.includes('public-t'))!.assetId;

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });
    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'unlock', password: 'pw' });
    // Trash BOTH while unlocked (trashAssets is itself guarded while locked).
    service.trashAssets({ libraryId: library.libraryId, assetIds: [vaultAssetId, publicAssetId] });
    expect(service.listTrash(library.libraryId).length).toBe(2);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'lock' });
    expect(service.listTrash(library.libraryId).map((asset) => asset.assetId)).toEqual([publicAssetId]);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'unlock', password: 'pw' });
    expect(service.listTrash(library.libraryId).length).toBe(2);
    service.closeAll();
  });

  it('excludes locked assets from the MCP-visible recent palette count', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'PalettePrivacy', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const publicFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });
    importNoConflict(service, library.libraryId, writePng(root, 'vault-p.png'), vault.folderId);
    importNoConflict(service, library.libraryId, writePng(root, 'public-p.png'), publicFolder.folderId);
    const palette = () => service.aggregateRecentAssetPalette({ libraryId: library.libraryId, days: 3650, limit: 24 });
    expect(palette().assetCount).toBe(2);
    expect(palette().colors).toEqual([]);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });
    expect(palette().assetCount).toBe(1);
    expect(palette().paletteAssetCount).toBe(0);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'unlock', password: 'pw' });
    expect(palette().assetCount).toBe(2);
    service.closeAll();
  });

  it('guards central asset source methods without deleting or marking assets missing', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'SourceGuards', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    importNoConflict(service, library.libraryId, writePng(root, 'g.png'), vault.folderId);
    const assetId = service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!.assetId;

    expect(() => service.getAssetMetadata({ libraryId: library.libraryId, assetId })).not.toThrow();
    expect(() => service.resolveAssetFilePath(library.libraryId, assetId)).not.toThrow();
    expect(() => service.resolveAssetPath(library.libraryId, assetId)).not.toThrow();

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });
    expectServiceCode(() => service.getAssetMetadata({ libraryId: library.libraryId, assetId }), 'FOLDER_LOCKED');
    expectServiceCode(() => service.resolveAssetFilePath(library.libraryId, assetId), 'FOLDER_LOCKED');
    expectServiceCode(() => service.resolveAssetPath(library.libraryId, assetId), 'FOLDER_LOCKED');

    // A FOLDER_LOCKED denial is a read fence only: it must never delete the
    // asset or flip availability (which scans/indexing would interpret as a
    // missing file). Unlocking restores the exact same asset and path.
    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'unlock', password: 'pw' });
    const restored = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(restored.length).toBe(1);
    expect(restored[0]!.assetId).toBe(assetId);
    expect(() => service.getAssetMetadata({ libraryId: library.libraryId, assetId })).not.toThrow();
    expect(existsSync(service.resolveAssetPath(library.libraryId, assetId))).toBe(true);
    service.closeAll();
  });

  it('keeps the tag taxonomy but excludes locked assignments from tag counts', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'TagPrivacy', selectedParentPath: root });
    const vault = service.createManagedFolder({ libraryId: library.libraryId, name: 'Vault' });
    const publicFolder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Public' });
    importNoConflict(service, library.libraryId, writePng(root, 'vault-tag.png'), vault.folderId);
    importNoConflict(service, library.libraryId, writePng(root, 'public-tag.png'), publicFolder.folderId);
    const assets = service.listAssets({ libraryId: library.libraryId, recursive: true });
    const vaultAssetId = assets.find((asset) => asset.displayName.includes('vault-tag'))!.assetId;
    const publicAssetId = assets.find((asset) => asset.displayName.includes('public-tag'))!.assetId;
    const tag = service.createTag({ libraryId: library.libraryId, name: 'Shared' });
    service.assignTags({
      libraryId: library.libraryId,
      assetIds: [vaultAssetId, publicAssetId],
      tagIds: [tag.tagId],
    });
    const vaultOnlyTag = service.createTag({ libraryId: library.libraryId, name: 'VaultOnly' });
    service.assignTags({ libraryId: library.libraryId, assetIds: [vaultAssetId], tagIds: [vaultOnlyTag.tagId] });
    const count = () => service.listTags(library.libraryId).find((t) => t.tagId === tag.tagId)!.assetCount;
    const vaultOnlyCount = () => service.listTags(library.libraryId).find((t) => t.tagId === vaultOnlyTag.tagId)?.assetCount;
    expect(count()).toBe(2);
    expect(vaultOnlyCount()).toBe(1);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'protect', password: 'pw' });
    expect(count()).toBe(1);
    expect(service.listTags(library.libraryId).map((t) => t.tagId)).toContain(tag.tagId);
    // A tag whose every assignment is locked stays in the taxonomy with a zero count.
    expect(vaultOnlyCount()).toBe(0);

    service.folderPrivacy({ libraryId: library.libraryId, folderId: vault.folderId, action: 'unlock', password: 'pw' });
    expect(count()).toBe(2);
    expect(vaultOnlyCount()).toBe(1);
    service.closeAll();
  });

  it('re-keys linked virtual privacy scopes when their directory is renamed', () => {
    const root = temporaryRoot();
    const service = new LibraryService();
    const library = service.createLibrary({ displayName: 'RenamePrivacy', selectedParentPath: root });
    const sourceRoot = path.join(root, 'ext');
    mkdirSync(path.join(sourceRoot, 'alpha', 'nested'), { recursive: true });
    mkdirSync(path.join(sourceRoot, 'beta'), { recursive: true });
    writePng(path.join(sourceRoot, 'alpha'), 'a.png');
    writePng(path.join(sourceRoot, 'alpha', 'nested'), 'n.png');
    writePng(path.join(sourceRoot, 'beta'), 'b.png');
    const linked = service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: sourceRoot });
    const alphaId = encodeLinkedVirtualFolderId(linked.folderId, 'alpha');
    const nestedId = encodeLinkedVirtualFolderId(linked.folderId, 'alpha/nested');

    service.folderPrivacy({ libraryId: library.libraryId, folderId: alphaId, action: 'protect', password: 'alpha-pw' });
    service.folderPrivacy({ libraryId: library.libraryId, folderId: nestedId, action: 'protect', password: 'nested-pw' });
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(1);

    // Unlock parent first (a covering lock would deny unlocking the child).
    service.folderPrivacy({ libraryId: library.libraryId, folderId: alphaId, action: 'unlock', password: 'alpha-pw' });
    service.folderPrivacy({ libraryId: library.libraryId, folderId: nestedId, action: 'unlock', password: 'nested-pw' });
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(3);

    service.renameLinkedFolderDirectory({
      libraryId: library.libraryId,
      linkedFolderId: linked.folderId,
      relativePath: 'alpha',
      newName: 'renamed',
    });

    const renamedAlphaId = encodeLinkedVirtualFolderId(linked.folderId, 'renamed');
    const renamedNestedId = encodeLinkedVirtualFolderId(linked.folderId, 'renamed/nested');
    const states = service.folderPrivacy({ libraryId: library.libraryId, action: 'status' }).states;
    expect(states.map((state) => state.folderId).sort()).toEqual([renamedAlphaId, renamedNestedId].sort());
    expect(states.every((state) => state.locked)).toBe(true);
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(1);

    // Scope identity survives a restart; the renamed files stay locked.
    const libraryPath = library.libraryPath;
    service.closeLibrary(library.libraryId);
    service.openLibrary(libraryPath);
    expect(service.folderPrivacy({ libraryId: library.libraryId, action: 'status' }).states
      .map((state) => state.folderId).sort()).toEqual([renamedAlphaId, renamedNestedId].sort());
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(1);

    // Passwords are preserved under the NEW ids.
    service.folderPrivacy({ libraryId: library.libraryId, folderId: renamedAlphaId, action: 'unlock', password: 'alpha-pw' });
    service.folderPrivacy({ libraryId: library.libraryId, folderId: renamedNestedId, action: 'unlock', password: 'nested-pw' });
    expect(service.listAssets({ libraryId: library.libraryId, recursive: true }).length).toBe(3);
    service.closeAll();
  });
});
