import { EXTENSION_ROOT_FOLDER_KEY } from './folder-menu';

/**
 * Browser-extension side of Serpent #91 / PR 92 folder privacy.
 *
 * The desktop is authoritative: it removes protected roots and ALL their
 * descendants from GET /folders before the extension ever sees them. These
 * helpers add defence in depth — the extension never trusts a cached folder
 * list, never falls back to the library root when a target becomes protected,
 * and never receives or stores a privacy password.
 *
 * GET /folders always carries `privacyRevision`. A `null` (or missing, i.e.
 * an old desktop build without privacy support) revision means the protection
 * state could NOT be confirmed; the extension MUST fail closed: hide every
 * folder entry, prune recents, close already-open menus and refuse saves.
 */

/** chrome.storage.local key; content scripts watch it to invalidate open menus. */
export const PRIVACY_REVISION_STORAGE_KEY = 'serpentPrivacyRevision';

export const PRIVACY_UNCONFIRMED_KIND = 'privacy-unconfirmed' as const;

export interface ExtensionFolderPrivacyFlag {
  readonly protected: boolean;
  readonly locked: boolean;
}

export interface ExtensionPrivacyFolderOption {
  readonly folderId: string;
  readonly privacy?: ExtensionFolderPrivacyFlag | null;
}

export interface ExtensionFolderPrivacySnapshot {
  readonly privacyRevision: string | null;
  readonly folders: readonly ExtensionPrivacyFolderOption[];
}

/** Normalize an untrusted revision from HTTP JSON or chrome.storage. */
export function normalizePrivacyRevision(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return null;
  return trimmed;
}

export type PrivacyRevisionChange = 'unchanged' | 'changed' | 'unconfirmed';

/**
 * Compare the persisted revision with a freshly fetched one.
 * - unconfirmed: incoming is null → fail closed, invalidate everything.
 * - changed: first confirmed observation or a protect / remove / lock / unlock.
 * - unchanged: same confirmed state, cached menus may stay.
 */
export function classifyPrivacyRevision(
  cached: string | null,
  incoming: string | null,
): PrivacyRevisionChange {
  const next = normalizePrivacyRevision(incoming);
  if (next === null) return 'unconfirmed';
  const previous = normalizePrivacyRevision(cached);
  if (previous === null || previous !== next) return 'changed';
  return 'unchanged';
}

/** Folder ids the desktop has explicitly declared visible right now. */
export function visibleExtensionFolderIds(
  folders: readonly ExtensionPrivacyFolderOption[],
): Set<string> {
  const visible = new Set<string>();
  for (const folder of folders) {
    if (!folder || typeof folder.folderId !== 'string' || folder.folderId.length === 0) continue;
    if (folder.privacy?.protected === true) continue;
    visible.add(folder.folderId);
  }
  return visible;
}

/**
 * Drop every recent id that is not currently visible. The '__root__' sentinel
 * is kept because it is not a folder and never belongs to a protected scope.
 */
export function pruneRecentFolderIdsForPrivacy(
  recentIds: readonly unknown[],
  visibleFolderIds: ReadonlySet<string>,
): string[] {
  const result: string[] = [];
  for (const id of recentIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (id === EXTENSION_ROOT_FOLDER_KEY) {
      result.push(id);
      continue;
    }
    if (visibleFolderIds.has(id)) result.push(id);
  }
  return result;
}

export type ExtensionSaveTargetValidation =
  | { readonly ok: true; readonly targetFolderId: string | null }
  | {
      readonly ok: false;
      readonly reason: 'privacy-unconfirmed' | 'stale-folder-target';
    };

/**
 * Validate a save target against a FRESH /folders response.
 *
 * - `undefined` target is REJECTED: it would mean "use whatever the desktop
 *   has selected", which could be a protected folder (silent fallback).
 * - `null` is an explicit "save to library root" and is allowed only when the
 *   privacy state is confirmed.
 * - Any id absent from the authoritative visible list, or carrying
 *   `privacy.protected`, is rejected with `stale-folder-target`.
 */
export function validateExtensionSaveTargetForPrivacy(
  targetFolderId: string | null | undefined,
  snapshot: ExtensionFolderPrivacySnapshot,
): ExtensionSaveTargetValidation {
  const revision = normalizePrivacyRevision(snapshot.privacyRevision);
  if (revision === null) {
    return { ok: false, reason: 'privacy-unconfirmed' };
  }
  const visible = visibleExtensionFolderIds(snapshot.folders);
  if (targetFolderId === null) return { ok: true, targetFolderId: null };
  if (
    typeof targetFolderId !== 'string' ||
    targetFolderId.length === 0 ||
    !visible.has(targetFolderId)
  ) {
    return { ok: false, reason: 'stale-folder-target' };
  }
  return { ok: true, targetFolderId };
}
