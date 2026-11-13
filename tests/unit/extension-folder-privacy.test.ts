import { describe, expect, it, vi } from 'vitest';

import {
  buildExtensionPrivacyView,
  fetchExtensionPrivacyView,
  filterExtensionFolders,
  filterExtensionRecentIds,
  validateExtensionSaveTarget,
  type ExtensionPrivacyFolderNode,
  type ExtensionPrivacyView,
} from '../../src/main/extension-folder-privacy';
import type { WorkerCommand } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';

/**
 * Serpent #91 / PR 92 — authoritative folder-privacy policy for the browser
 * extension native interface. The desktop is authoritative: a protected root
 * and EVERY descendant must be hidden from the extension menu, tree, picker
 * and recents even while the desktop is unlocked, and an unconfirmable state
 * must fail closed (hide everything, reject every save).
 */

function folder(
  folderId: string,
  extra: Partial<ExtensionPrivacyFolderNode> = {},
): ExtensionPrivacyFolderNode {
  return { folderId, ...extra };
}

const REVISION_PREFIX = 'serpent-folder-privacy-v1:';

describe('buildExtensionPrivacyView', () => {
  it('hides a protected managed root and all descendants by parentFolderId', () => {
    const view = buildExtensionPrivacyView({
      states: [{ folderId: 'vault', locked: true }],
      folders: [
        folder('root'),
        folder('vault', { parentFolderId: 'root', privacy: { protected: true, locked: true } }),
        folder('vault-child', { parentFolderId: 'vault' }),
        folder('vault-grandchild', { parentFolderId: 'vault-child' }),
        folder('other', { parentFolderId: 'root' }),
      ],
    });

    expect(view.stateConfirmed).toBe(true);
    expect(view.hasProtectedFolders).toBe(true);
    expect([...view.hiddenFolderIds].sort()).toEqual([
      'vault',
      'vault-child',
      'vault-grandchild',
    ]);
    expect([...view.visibleFolderIds].sort()).toEqual(['other', 'root']);
  });

  it('stays hidden while the desktop is unlocked (stronger than "when locked")', () => {
    // Worker reports the root with locked:false (unlocked) but still protected.
    const view = buildExtensionPrivacyView({
      states: [{ folderId: 'vault', locked: false }],
      folders: [
        folder('vault', { privacy: { protected: true, locked: false } }),
        folder('vault-child', { parentFolderId: 'vault' }),
      ],
    });
    expect(view.hiddenFolderIds.has('vault')).toBe(true);
    expect(view.hiddenFolderIds.has('vault-child')).toBe(true);
    expect(view.visibleFolderIds.has('vault')).toBe(false);
    expect(view.visibleFolderIds.has('vault-child')).toBe(false);
    expect(view.hasProtectedFolders).toBe(true);
  });

  it('expands a protected linked root to omitted lfv: descendants via id prefix', () => {
    // While locked the Worker omits descendants from folder.list; only the root
    // plus an unrelated folder are known, but the descendant ids still exist.
    const view = buildExtensionPrivacyView({
      states: [{ folderId: 'linked-1', locked: true }],
      folders: [
        folder('linked-1', { relativePath: '' }),
        folder('lfv:linked-1/Concept/Character'),
        folder('lfv:linked-1/Concept'),
        folder('unrelated'),
      ],
    });
    // Omitted descendants are not in knownIds, so they cannot be listed; the
    // ones that ARE present must be hidden.
    expect(view.hiddenFolderIds.has('lfv:linked-1/Concept')).toBe(true);
    expect(view.hiddenFolderIds.has('lfv:linked-1/Concept/Character')).toBe(true);
    expect(view.visibleFolderIds.has('lfv:linked-1/Concept')).toBe(false);
    expect(view.visibleFolderIds.has('unrelated')).toBe(true);
  });

  it('hides only the subtree of a protected linked virtual subfolder', () => {
    const view = buildExtensionPrivacyView({
      states: [{ folderId: 'lfv:linked-1/Concept', locked: true }],
      folders: [
        folder('linked-1'),
        folder('lfv:linked-1/Concept'),
        folder('lfv:linked-1/Concept/Character'),
        folder('lfv:linked-1/Environment'),
        folder('lfv:linked-1'),
      ],
    });
    expect(view.hiddenFolderIds.has('lfv:linked-1/Concept')).toBe(true);
    expect(view.hiddenFolderIds.has('lfv:linked-1/Concept/Character')).toBe(true);
    // Sibling branch under the same linked root stays visible.
    expect(view.visibleFolderIds.has('lfv:linked-1/Environment')).toBe(true);
    expect(view.visibleFolderIds.has('lfv:linked-1')).toBe(true);
  });

  it('treats a folder summary privacy flag as a defensive protection source', () => {
    // Worker states does not report it, but the summary carries protected:true.
    const view = buildExtensionPrivacyView({
      states: [],
      folders: [
        folder('secret', { privacy: { protected: true, locked: true } }),
        folder('secret-child', { parentFolderId: 'secret' }),
      ],
    });
    expect(view.hiddenFolderIds.has('secret')).toBe(true);
    expect(view.hiddenFolderIds.has('secret-child')).toBe(true);
    expect(view.hasProtectedFolders).toBe(true);
  });

  it('reports no protected folders for an empty protection state', () => {
    const view = buildExtensionPrivacyView({
      states: [],
      folders: [folder('a'), folder('b', { parentFolderId: 'a' })],
    });
    expect(view.hasProtectedFolders).toBe(false);
    expect(view.hiddenFolderIds.size).toBe(0);
    expect([...view.visibleFolderIds].sort()).toEqual(['a', 'b']);
  });

  it('produces a stable opaque revision with no raw folder ids', () => {
    const build = (locked: boolean): ExtensionPrivacyView =>
      buildExtensionPrivacyView({
        states: [{ folderId: 'vault', locked }],
        folders: [folder('vault'), folder('vault-child', { parentFolderId: 'vault' })],
      });
    const a = build(true);
    const b = build(true);
    expect(a.privacyRevision).toBe(b.privacyRevision);
    expect(a.privacyRevision).toMatch(new RegExp('^' + REVISION_PREFIX + '[0-9a-f]{64}$'));
    expect(a.privacyRevision).not.toContain('vault');
  });

  it('changes the revision on protect, lock/unlock and new-protected-descendant states', () => {
    const unlocked = buildExtensionPrivacyView({
      states: [{ folderId: 'vault', locked: false }],
      folders: [folder('vault'), folder('vault-child', { parentFolderId: 'vault' })],
    });
    const relocked = buildExtensionPrivacyView({
      states: [{ folderId: 'vault', locked: true }],
      folders: [folder('vault'), folder('vault-child', { parentFolderId: 'vault' })],
    });
    const removed = buildExtensionPrivacyView({ states: [], folders: [folder('vault')] });
    expect(unlocked.privacyRevision).not.toBe(relocked.privacyRevision);
    expect(relocked.privacyRevision).not.toBe(removed.privacyRevision);

    const extraDescendant = buildExtensionPrivacyView({
      states: [{ folderId: 'vault', locked: true }],
      folders: [
        folder('vault'),
        folder('vault-child', { parentFolderId: 'vault' }),
        folder('vault-child-2', { parentFolderId: 'vault' }),
      ],
    });
    expect(extraDescendant.privacyRevision).not.toBe(relocked.privacyRevision);
  });

  it('ignores duplicate and malformed folder ids instead of throwing', () => {
    const view = buildExtensionPrivacyView({
      states: [{ folderId: 'vault', locked: true }],
      folders: [
        folder(''),
        folder('vault'),
        folder('vault'),
        { folderId: 'valid' },
        {} as ExtensionPrivacyFolderNode,
        null as unknown as ExtensionPrivacyFolderNode,
      ],
    });
    expect(view.hiddenFolderIds.has('vault')).toBe(true);
    expect(view.visibleFolderIds.has('valid')).toBe(true);
    expect(view.visibleFolderIds.has('')).toBe(false);
  });
});

describe('fetchExtensionPrivacyView', () => {
  const okStatus = (states: Array<{ folderId: string; locked: boolean }>): WorkerResult => ({
    ok: true,
    type: 'folder.privacy',
    libraryId: 'lib',
    states,
  });

  it('builds the view from the Worker status when folders are supplied', async () => {
    const request = vi.fn(async (command: WorkerCommand) => {
      expect(command.type).toBe('folder.privacy');
      return okStatus([{ folderId: 'vault', locked: true }]);
    });
    const view = await fetchExtensionPrivacyView(
      request,
      'lib',
      [folder('vault'), folder('vault-child', { parentFolderId: 'vault' }), folder('ok')],
    );
    expect(view.stateConfirmed).toBe(true);
    expect(view.hiddenFolderIds.has('vault-child')).toBe(true);
    expect(view.visibleFolderIds.has('ok')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fetches folder.list and linked-folder.list itself when folders are omitted', async () => {
    const request = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'folder.privacy') return okStatus([{ folderId: 'vault', locked: true }]);
      if (command.type === 'folder.list') {
        return {
          ok: true,
          type: 'folder.list',
          libraryId: 'lib',
          folders: [
            { folderId: 'vault', name: 'Vault', relativePath: 'Vault', parentFolderId: null, directAssetCount: 0 },
            { folderId: 'vault-child', name: 'Child', relativePath: 'Vault/Child', parentFolderId: 'vault', directAssetCount: 0 },
          ],
        } as unknown as WorkerResult;
      }
      if (command.type === 'linked-folder.list') {
        return { ok: true, type: 'linked-folder.list', libraryId: 'lib', folders: [] } as unknown as WorkerResult;
      }
      throw new Error('unexpected ' + command.type);
    });
    const view = await fetchExtensionPrivacyView(request, 'lib');
    expect(view.stateConfirmed).toBe(true);
    expect(view.hiddenFolderIds.has('vault')).toBe(true);
    expect(view.hiddenFolderIds.has('vault-child')).toBe(true);
  });

  it('fails closed when the status response is not ok / wrong type / wrong library', async () => {
    const cases: WorkerResult[] = [
      { ok: false, type: 'folder.privacy', libraryId: 'lib', error: { code: 'X', message: 'm' } } as unknown as WorkerResult,
      { ok: true, type: 'folder.list', libraryId: 'lib', folders: [] } as unknown as WorkerResult,
      okStatus([]) && { ...okStatus([]), libraryId: 'other' } as WorkerResult,
    ];
    for (const result of cases) {
      const view = await fetchExtensionPrivacyView(async () => result, 'lib', [folder('a')]);
      expect(view.stateConfirmed).toBe(false);
      expect(view.privacyRevision).toBeNull();
      expect(view.visibleFolderIds.size).toBe(0);
      expect(view.hiddenFolderIds.has('a')).toBe(true);
    }
  });

  it('fails closed on malformed state entries', async () => {
    const result = {
      ok: true,
      type: 'folder.privacy',
      libraryId: 'lib',
      states: [{ folderId: 'vault' }], // missing locked boolean
    } as unknown as WorkerResult;
    const view = await fetchExtensionPrivacyView(async () => result, 'lib', [folder('vault')]);
    expect(view.stateConfirmed).toBe(false);
    expect(view.visibleFolderIds.size).toBe(0);
  });

  it('fails closed when a required folder.list sub-request fails', async () => {
    const request = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'folder.privacy') return okStatus([]);
      if (command.type === 'folder.list') {
        return { ok: true, type: 'folder.list', libraryId: 'lib', folders: [{ folderId: 'a', name: 'A', relativePath: 'A' }] } as unknown as WorkerResult;
      }
      return { ok: false, type: 'linked-folder.list', libraryId: 'lib', error: { code: 'X', message: 'm' } } as unknown as WorkerResult;
    });
    const view = await fetchExtensionPrivacyView(request, 'lib');
    expect(view.stateConfirmed).toBe(false);
    expect(view.privacyRevision).toBeNull();
  });

  it('fails closed on a thrown transport error and on an empty library id', async () => {
    const thrown = await fetchExtensionPrivacyView(
      async () => { throw new Error('boom'); },
      'lib',
      [folder('a')],
    );
    expect(thrown.stateConfirmed).toBe(false);
    expect(thrown.hiddenFolderIds.has('a')).toBe(true);

    const noLib = await fetchExtensionPrivacyView(async () => okStatus([]), '', [folder('a')]);
    expect(noLib.stateConfirmed).toBe(false);
    expect(noLib.visibleFolderIds.size).toBe(0);
  });
});

describe('filterExtensionFolders', () => {
  const folders = [
    { folderId: 'vault', privacy: { protected: true } },
    { folderId: 'vault-child' },
    { folderId: 'keep' },
    { folderId: 'stale-deleted' },
  ];

  it('drops hidden ids and explicit protected flags', () => {
    const hidden = new Set(['vault', 'vault-child']);
    const out = filterExtensionFolders(folders, hidden);
    expect(out.map((f) => f.folderId)).toEqual(['keep', 'stale-deleted']);
  });

  it('rejects any id not in the authoritative visible allow-list', () => {
    const hidden = new Set(['vault', 'vault-child']);
    const visible = new Set(['keep']);
    const out = filterExtensionFolders(folders, hidden, visible);
    expect(out.map((f) => f.folderId)).toEqual(['keep']);
  });
});

describe('filterExtensionRecentIds', () => {
  it('drops hidden ids, empties and ids outside the visible allow-list', () => {
    const hidden = new Set(['vault']);
    const visible = new Set(['keep', 'vault-child-hidden-not-listed']);
    const out = filterExtensionRecentIds(['vault', 'keep', 'stale', '', 'keep'], hidden, visible);
    // vault hidden; stale not visible; '' dropped; duplicate keep preserved.
    expect(out).toEqual(['keep', 'keep']);
  });

  it('keeps everything visible when no allow-list is supplied', () => {
    expect(filterExtensionRecentIds(['a', 'b'], new Set<string>())).toEqual(['a', 'b']);
  });
});

describe('validateExtensionSaveTarget', () => {
  const hidden = new Set(['vault', 'vault-child']);
  const visible = new Set(['keep', 'root']);

  it('rejects every save when the privacy state is unconfirmed (fail closed)', () => {
    for (const targetFolderId of [null, undefined, 'keep', 'vault']) {
      const verdict = validateExtensionSaveTarget({
        targetFolderId,
        hiddenFolderIds: hidden,
        visibleFolderIds: visible,
        stateConfirmed: false,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
  });

  it('allows an explicit library-root save only when confirmed', () => {
    const verdict = validateExtensionSaveTarget({
      targetFolderId: null,
      hiddenFolderIds: hidden,
      visibleFolderIds: visible,
      stateConfirmed: true,
    });
    expect(verdict).toEqual({ ok: true, targetFolderId: null });
  });

  it('rejects a hidden/protected target and a stale id', () => {
    for (const targetFolderId of ['vault', 'vault-child', 'stale-deleted']) {
      const verdict = validateExtensionSaveTarget({
        targetFolderId,
        hiddenFolderIds: hidden,
        visibleFolderIds: visible,
        stateConfirmed: true,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
  });

  it('accepts a visible target', () => {
    expect(
      validateExtensionSaveTarget({
        targetFolderId: 'keep',
        hiddenFolderIds: hidden,
        visibleFolderIds: visible,
        stateConfirmed: true,
      }),
    ).toEqual({ ok: true, targetFolderId: 'keep' });
  });

  it('resolves undefined to the desktop-selected folder and validates it (no blind root fallback)', () => {
    const hiddenSelection = validateExtensionSaveTarget({
      targetFolderId: undefined,
      selectedFolderId: 'vault',
      hiddenFolderIds: hidden,
      visibleFolderIds: visible,
      stateConfirmed: true,
    });
    expect(hiddenSelection.ok).toBe(false);

    const visibleSelection = validateExtensionSaveTarget({
      targetFolderId: undefined,
      selectedFolderId: 'keep',
      hiddenFolderIds: hidden,
      visibleFolderIds: visible,
      stateConfirmed: true,
    });
    expect(visibleSelection).toEqual({ ok: true, targetFolderId: 'keep' });
  });

  it('defaults stateConfirmed to true for backwards compatibility', () => {
    const verdict = validateExtensionSaveTarget({
      targetFolderId: 'keep',
      hiddenFolderIds: hidden,
    });
    expect(verdict).toEqual({ ok: true, targetFolderId: 'keep' });
  });
});
