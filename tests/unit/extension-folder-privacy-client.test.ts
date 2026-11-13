import { describe, expect, it } from 'vitest';

import {
  EXTENSION_ROOT_FOLDER_KEY,
} from '../../extension/folder-menu';
import {
  PRIVACY_REVISION_STORAGE_KEY,
  PRIVACY_UNCONFIRMED_KIND,
  classifyPrivacyRevision,
  normalizePrivacyRevision,
  pruneRecentFolderIdsForPrivacy,
  validateExtensionSaveTargetForPrivacy,
  visibleExtensionFolderIds,
  type ExtensionFolderPrivacySnapshot,
  type ExtensionPrivacyFolderOption,
} from '../../extension/folder-privacy';

/**
 * Serpent #91 / PR 92 — browser-extension side of folder privacy. The desktop
 * is authoritative and filters protected scopes from GET /folders; these
 * helpers add defence in depth. A null/unconfirmed revision MUST fail closed:
 * hide everything, prune recents, reject saves. A save target that is stale or
 * protected MUST be rejected, never silently redirected to the library root.
 */

describe('constants', () => {
  it('exposes stable storage/unconfirmed markers', () => {
    expect(PRIVACY_REVISION_STORAGE_KEY).toBe('serpentPrivacyRevision');
    expect(PRIVACY_UNCONFIRMED_KIND).toBe('privacy-unconfirmed');
  });
});

describe('normalizePrivacyRevision', () => {
  it('accepts non-empty trimmed strings', () => {
    expect(normalizePrivacyRevision('  rev-1  ')).toBe('rev-1');
    expect(normalizePrivacyRevision('a'.repeat(512))).toBe('a'.repeat(512));
  });

  it('rejects non-strings, empty, whitespace-only and oversized values', () => {
    for (const value of [null, undefined, 42, {}, [], '', '   ', 'a'.repeat(513)]) {
      expect(normalizePrivacyRevision(value)).toBeNull();
    }
  });
});

describe('classifyPrivacyRevision', () => {
  it('fails closed when the incoming revision is unconfirmable', () => {
    expect(classifyPrivacyRevision('rev-1', null)).toBe('unconfirmed');
    expect(classifyPrivacyRevision(null, '   ')).toBe('unconfirmed');
    expect(classifyPrivacyRevision('rev-1', 42 as unknown as string)).toBe('unconfirmed');
  });

  it('reports changed on first confirmation and on any mutation', () => {
    expect(classifyPrivacyRevision(null, 'rev-1')).toBe('changed');
    expect(classifyPrivacyRevision('rev-1', 'rev-2')).toBe('changed');
  });

  it('reports unchanged for the same confirmed revision (ignoring whitespace)', () => {
    expect(classifyPrivacyRevision('rev-1', 'rev-1')).toBe('unchanged');
    expect(classifyPrivacyRevision('rev-1', '  rev-1  ')).toBe('unchanged');
  });
});

describe('visibleExtensionFolderIds', () => {
  it('keeps only non-protected, well-formed folders', () => {
    const folders: ExtensionPrivacyFolderOption[] = [
      { folderId: 'a' },
      { folderId: 'b', privacy: { protected: false, locked: false } },
      { folderId: 'vault', privacy: { protected: true, locked: true } },
      { folderId: 'vault-unlocked', privacy: { protected: true, locked: false } },
      { folderId: '' },
      { folderId: 42 as unknown as string },
    ];
    expect([...visibleExtensionFolderIds(folders)].sort()).toEqual(['a', 'b']);
  });
});

describe('pruneRecentFolderIdsForPrivacy', () => {
  it('drops hidden ids but keeps the root sentinel and visible ids', () => {
    const visible = new Set(['keep']);
    const pruned = pruneRecentFolderIdsForPrivacy(
      ['vault', 'keep', EXTENSION_ROOT_FOLDER_KEY, 'stale', '', 42],
      visible,
    );
    expect(pruned).toEqual(['keep', EXTENSION_ROOT_FOLDER_KEY]);
  });

  it('returns an empty list when nothing is visible', () => {
    expect(pruneRecentFolderIdsForPrivacy(['vault', 'other'], new Set<string>())).toEqual([]);
  });
});

describe('validateExtensionSaveTargetForPrivacy', () => {
  const snapshot: ExtensionFolderPrivacySnapshot = {
    privacyRevision: 'rev-1',
    folders: [
      { folderId: 'keep' },
      { folderId: 'vault', privacy: { protected: true, locked: true } },
    ],
  };

  it('rejects every target when the revision is unconfirmed (fail closed)', () => {
    const unconfirmed: ExtensionFolderPrivacySnapshot = {
      privacyRevision: null,
      folders: [{ folderId: 'keep' }],
    };
    for (const target of [null, undefined, 'keep', 'vault']) {
      const verdict = validateExtensionSaveTargetForPrivacy(target, unconfirmed);
      expect(verdict).toEqual({ ok: false, reason: 'privacy-unconfirmed' });
    }
  });

  it('allows an explicit library-root save when confirmed', () => {
    expect(validateExtensionSaveTargetForPrivacy(null, snapshot)).toEqual({
      ok: true,
      targetFolderId: null,
    });
  });

  it('rejects an undefined target (would mean "whatever is selected")', () => {
    expect(validateExtensionSaveTargetForPrivacy(undefined, snapshot)).toEqual({
      ok: false,
      reason: 'stale-folder-target',
    });
  });

  it('rejects a protected or unknown/stale target instead of saving to root', () => {
    for (const target of ['vault', 'stale-deleted', '']) {
      expect(validateExtensionSaveTargetForPrivacy(target, snapshot)).toEqual({
        ok: false,
        reason: 'stale-folder-target',
      });
    }
  });

  it('accepts a currently-visible target', () => {
    expect(validateExtensionSaveTargetForPrivacy('keep', snapshot)).toEqual({
      ok: true,
      targetFolderId: 'keep',
    });
  });
});
