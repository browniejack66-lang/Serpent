import { createHash } from 'node:crypto';

import type { FolderPrivacyState } from '../shared/folder-privacy';
import { LINKED_VIRTUAL_FOLDER_PREFIX } from '../shared/linked-folder-tree';
import type { WorkerCommand } from '../shared/protocol/requests';
import type { WorkerResult } from '../shared/protocol/responses';

/**
 * Authoritative folder-privacy policy for the browser-extension native interface.
 *
 * Serpent #91 / PR 92: a protected folder root and *every* descendant must be
 * absent from the extension menu, folder tree, picker and recents. The desktop
 * (not the extension) owns this decision, and the extension never receives or
 * stores a privacy password.
 *
 * The Worker `folder.privacy` status response lists ONLY explicit protection
 * roots (including roots that are currently unlocked) and never infers
 * descendants. This module expands those roots over the complete folder tree,
 * so hidden scopes always cover the root plus all of its children. When a
 * library is locked the Worker may omit protected descendants from
 * `folder.list` entirely, so expansion ALSO uses linked-folder id path
 * prefixes (`lfv:{rootId}/{relativePath}`) and produces an authoritative
 * `visibleFolderIds` set that rejects any unknown / stale id.
 *
 * Policy is intentionally *stronger* than the proposal's "when locked": any
 * configured protected scope is hidden even while the desktop is unlocked.
 * Unlock is a desktop-only operation and must never be observable by the
 * extension as a change in what may be listed or saved.
 */

export interface ExtensionPrivacyFolderNode {
  readonly folderId: string;
  readonly parentFolderId?: string | null;
  readonly relativePath?: string | null;
  readonly privacy?: { readonly protected: boolean; readonly locked: boolean } | null;
}

export interface ExtensionPrivacyView {
  /** Explicit protection roots plus all of their descendants. */
  readonly hiddenFolderIds: ReadonlySet<string>;
  /**
   * Authoritative allow-list: every folder id the desktop may list or accept as
   * a save target right now. EMPTY when the state is unconfirmed. Consumers
   * MUST intersect against it — a stale id absent from the hidden set (deleted
   * folder, omitted locked descendant) is still not valid.
   */
  readonly visibleFolderIds: ReadonlySet<string>;
  /**
   * Opaque, deterministic hash of the confirmed protection state. No raw
   * folder ids are exposed. `null` means the state could NOT be confirmed;
   * every consumer must fail closed.
   */
  readonly privacyRevision: string | null;
  readonly stateConfirmed: boolean;
  /** True when at least one protected scope is known (or state is unconfirmed). */
  readonly hasProtectedFolders: boolean;
}

export interface ExtensionPrivacyViewInput {
  readonly states: readonly FolderPrivacyState[];
  readonly folders: readonly ExtensionPrivacyFolderNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNode(value: unknown): ExtensionPrivacyFolderNode | undefined {
  if (!isRecord(value) || typeof value.folderId !== 'string' || value.folderId.length === 0) {
    return undefined;
  }
  const parentFolderId = typeof value.parentFolderId === 'string' ? value.parentFolderId : null;
  const relativePath = typeof value.relativePath === 'string' ? value.relativePath : null;
  const privacy = isRecord(value.privacy)
    ? { protected: value.privacy.protected === true, locked: value.privacy.locked === true }
    : undefined;
  return {
    folderId: value.folderId,
    parentFolderId,
    ...(relativePath !== null ? { relativePath } : {}),
    ...(privacy ? { privacy } : {}),
  };
}

/**
 * Linked virtual folder ids encode their hierarchy as `lfv:{rootId}/{path}`.
 * A protected linked root (`{rootId}`) therefore owns every `lfv:{rootId}/...`
 * descendant even when `folder.list` omits those nodes while locked. A
 * protected virtual subfolder owns only its own `.../` path prefix.
 */
function linkedIdPrefix(rootId: string): string {
  return rootId.startsWith(LINKED_VIRTUAL_FOLDER_PREFIX)
    ? `${rootId}/`
    : `${LINKED_VIRTUAL_FOLDER_PREFIX}${rootId}/`;
}

/** Build the immutable privacy view from a confirmed status + complete tree. */
export function buildExtensionPrivacyView(input: ExtensionPrivacyViewInput): ExtensionPrivacyView {
  // Map folderId -> locked. Worker states are authoritative; folder summaries
  // provide a defensive second source for roots the Worker did not report.
  const rootStates = new Map<string, boolean>();
  for (const state of input.states) {
    if (typeof state?.folderId !== 'string' || state.folderId.length === 0) continue;
    if (!rootStates.has(state.folderId)) rootStates.set(state.folderId, state.locked === true);
  }
  const nodes: ExtensionPrivacyFolderNode[] = [];
  for (const folder of input.folders) {
    const node = normalizeNode(folder);
    if (!node) continue;
    nodes.push(node);
    if (node.privacy?.protected === true || node.privacy?.locked === true) {
      if (!rootStates.has(node.folderId)) rootStates.set(node.folderId, node.privacy.locked === true);
    }
  }

  const knownIds = new Set(nodes.map((node) => node.folderId));

  // 1) Expand roots to descendants via parentFolderId, guarding against cycles.
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentFolderId) continue;
    const siblings = childrenByParent.get(node.parentFolderId);
    if (siblings) siblings.push(node.folderId);
    else childrenByParent.set(node.parentFolderId, [node.folderId]);
  }
  const hiddenFolderIds = new Set<string>();
  const queue = [...rootStates.keys()];
  while (queue.length > 0) {
    const folderId = queue.shift();
    if (folderId === undefined || hiddenFolderIds.has(folderId)) continue;
    hiddenFolderIds.add(folderId);
    for (const child of childrenByParent.get(folderId) ?? []) queue.push(child);
  }

  // 2) Expand via linked folder id path prefixes. This catches descendants the
  //    Worker omitted from folder.list while locked. Iterate to a fixed point
  //    so a newly hidden virtual folder also hides its own descendants.
  let changed = true;
  while (changed) {
    changed = false;
    const prefixes = [...hiddenFolderIds].map(linkedIdPrefix);
    for (const folderId of knownIds) {
      if (hiddenFolderIds.has(folderId)) continue;
      if (prefixes.some((prefix) => folderId.startsWith(prefix))) {
        hiddenFolderIds.add(folderId);
        changed = true;
      }
    }
  }

  // 3) Authoritative allow-list: hidden or unknown ids are never visible.
  const visibleFolderIds = new Set<string>();
  for (const folderId of knownIds) {
    if (!hiddenFolderIds.has(folderId)) visibleFolderIds.add(folderId);
  }

  // Opaque hash: any protect / remove / lock / unlock / new descendant under a
  // protected root invalidates extension caches, open menus and recent items.
  const sortedRoots = [...rootStates.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([folderId, locked]) => ({ folderId, locked }));
  const revisionPayload = JSON.stringify({
    version: 1,
    roots: sortedRoots,
    hidden: [...hiddenFolderIds].sort(),
  });
  const privacyRevision = `serpent-folder-privacy-v1:${createHash('sha256')
    .update(revisionPayload)
    .digest('hex')}`;

  return {
    hiddenFolderIds,
    visibleFolderIds,
    privacyRevision,
    stateConfirmed: true,
    hasProtectedFolders: rootStates.size > 0,
  };
}

/**
 * Fail closed: when the privacy state cannot be confirmed, NO folder may be
 * listed or used. `visibleFolderIds` is empty, `privacyRevision` is null and
 * every known id is hidden.
 */
function unconfirmedPrivacyView(folders: readonly ExtensionPrivacyFolderNode[]): ExtensionPrivacyView {
  const hiddenFolderIds = new Set<string>();
  for (const folder of folders) {
    const node = normalizeNode(folder);
    if (node) hiddenFolderIds.add(node.folderId);
  }
  return {
    hiddenFolderIds,
    visibleFolderIds: new Set<string>(),
    privacyRevision: null,
    stateConfirmed: false,
    hasProtectedFolders: true,
  };
}

export type ExtensionPrivacyWorkerRequest = (command: WorkerCommand) => Promise<WorkerResult>;

/**
 * Ask the Worker for the current protection state and build the privacy view.
 *
 * When `folders` is supplied the caller already holds the complete managed +
 * linked folder tree (the normal `handleListFolders` path). When omitted this
 * helper fetches `folder.list` and `linked-folder.list` itself, which is what
 * save handlers should do so a stale selected target cannot be used.
 *
 * ANY Worker error, transport failure, wrong library or malformed response
 * returns an unconfirmed view (`stateConfirmed: false`, `privacyRevision: null`,
 * empty `visibleFolderIds`). Never fall back to an unfiltered folder list.
 */
export async function fetchExtensionPrivacyView(
  request: ExtensionPrivacyWorkerRequest,
  libraryId: string,
  folders?: readonly ExtensionPrivacyFolderNode[],
): Promise<ExtensionPrivacyView> {
  if (typeof libraryId !== 'string' || libraryId.length === 0) {
    return unconfirmedPrivacyView(folders ?? []);
  }
  try {
    const privacyResult: unknown = await request({ type: 'folder.privacy', libraryId, action: 'status' });
    if (
      !isRecord(privacyResult) ||
      privacyResult.ok !== true ||
      privacyResult.type !== 'folder.privacy' ||
      privacyResult.libraryId !== libraryId ||
      !Array.isArray(privacyResult.states)
    ) {
      return unconfirmedPrivacyView(folders ?? []);
    }
    const states: FolderPrivacyState[] = [];
    for (const entry of privacyResult.states) {
      if (
        !isRecord(entry) ||
        typeof entry.folderId !== 'string' ||
        entry.folderId.length === 0 ||
        typeof entry.locked !== 'boolean'
      ) {
        return unconfirmedPrivacyView(folders ?? []);
      }
      states.push({ folderId: entry.folderId, locked: entry.locked });
    }

    let nodes: readonly ExtensionPrivacyFolderNode[] = folders ?? [];
    if (!folders) {
      const managedResult: unknown = await request({ type: 'folder.list', libraryId });
      const linkedResult: unknown = await request({ type: 'linked-folder.list', libraryId });
      const partial: ExtensionPrivacyFolderNode[] = [];
      const expectedTypes: readonly [unknown, string][] = [
        [managedResult, 'folder.list'],
        [linkedResult, 'linked-folder.list'],
      ];
      for (const [result, expectedType] of expectedTypes) {
        if (
          !isRecord(result) ||
          result.ok !== true ||
          result.type !== expectedType ||
          !Array.isArray(result.folders)
        ) {
          return unconfirmedPrivacyView(partial);
        }
        for (const folder of result.folders) {
          const node = normalizeNode(folder);
          if (node) partial.push(node);
        }
      }
      nodes = partial;
    }
    return buildExtensionPrivacyView({ states, folders: nodes });
  } catch {
    return unconfirmedPrivacyView(folders ?? []);
  }
}

/**
 * Remove protected scopes and any id not present in the authoritative
 * allow-list. Pass `visibleFolderIds` from the view for strict filtering.
 */
export function filterExtensionFolders<
  T extends { readonly folderId: string; readonly privacy?: { readonly protected: boolean } | null },
>(
  folders: readonly T[],
  hiddenFolderIds: ReadonlySet<string>,
  visibleFolderIds?: ReadonlySet<string>,
): T[] {
  return folders.filter(
    (folder) =>
      typeof folder.folderId === 'string' &&
      folder.folderId.length > 0 &&
      !hiddenFolderIds.has(folder.folderId) &&
      folder.privacy?.protected !== true &&
      (!visibleFolderIds || visibleFolderIds.has(folder.folderId)),
  );
}

/**
 * Recents must not leak names/paths/counts of protected scopes. Intersecting
 * with `visibleFolderIds` also drops deleted folders and hidden descendants
 * whose ids are absent from the hidden set.
 */
export function filterExtensionRecentIds(
  ids: readonly string[],
  hiddenFolderIds: ReadonlySet<string>,
  visibleFolderIds?: ReadonlySet<string>,
): string[] {
  return ids.filter(
    (id) =>
      typeof id === 'string' &&
      id.length > 0 &&
      !hiddenFolderIds.has(id) &&
      (!visibleFolderIds || visibleFolderIds.has(id)),
  );
}

export type ExtensionSaveTargetVerdict =
  | { readonly ok: true; readonly targetFolderId: string | null }
  | { readonly ok: false; readonly status: 403; readonly reason: string };

export interface ExtensionSaveTargetInput {
  readonly targetFolderId: string | null | undefined;
  readonly selectedFolderId?: string | undefined;
  readonly hiddenFolderIds: ReadonlySet<string>;
  /** Defaults to true for backwards compatibility; pass the view's flag. */
  readonly stateConfirmed?: boolean;
  /**
   * Authoritative allow-list. When supplied a target MUST appear in it, so an
   * unknown / stale id not present in `hiddenFolderIds` is still rejected.
   */
  readonly visibleFolderIds?: ReadonlySet<string>;
}

/**
 * Validate an extension save target against the authoritative privacy view.
 *
 * - `targetFolderId === undefined` resolves to the desktop-selected folder,
 *   which is then validated too (never a blind fallback to the library root).
 * - A hidden / stale / protected target is REJECTED with HTTP 403; the caller
 *   must prompt for a new target and must NOT silently save to root.
 * - An unconfirmed privacy state rejects every save (fail closed).
 */
export function validateExtensionSaveTarget(input: ExtensionSaveTargetInput): ExtensionSaveTargetVerdict {
  if (input.stateConfirmed === false) {
    return {
      ok: false,
      status: 403,
      reason: '隐私状态无法确认，请重新选择可用目录后再保存。',
    };
  }
  const resolved =
    input.targetFolderId === undefined ? input.selectedFolderId : input.targetFolderId;
  if (resolved === undefined || resolved === null) {
    // Explicit "save to library root" is allowed only when the state is
    // confirmed and no selected folder is hidden.
    return { ok: true, targetFolderId: null };
  }
  if (
    typeof resolved !== 'string' ||
    resolved.length === 0 ||
    input.hiddenFolderIds.has(resolved) ||
    (input.visibleFolderIds !== undefined && !input.visibleFolderIds.has(resolved))
  ) {
    return {
      ok: false,
      status: 403,
      reason: '目标目录已受保护或已失效，请重新选择可用目录，不会静默改存到其他位置。',
    };
  }
  return { ok: true, targetFolderId: resolved };
}
