import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import {
  encodeLinkedVirtualFolderId,
  parseLinkedVirtualFolderId,
} from '../shared/linked-folder-tree';
import type { FolderPrivacyBadge } from '../shared/folder-privacy';
import type {
  FolderPrivacyInput,
  FolderPrivacyResult,
  FolderPrivacyState,
} from '../shared/folder-privacy';

/**
 * Central folder privacy policy.
 *
 * 1. ONE row per protected ROOT scope (folder_privacy table). Descendants are
 *    never materialized; they inherit the lock via ancestor-prefix
 *    containment computed at read/write time.
 * 2. A protected scope is LOCKED unless its root is unlocked in this process.
 *    Unlock state is memory-only and dropped when the library closes.
 * 3. Enforcement is a single SQL predicate (privacyHiddenAssetsSql) ANDed into
 *    every catalog/browse/search/count/media query. It is INDEPENDENT of
 *    showIgnored: showing ignored must NEVER reveal a locked scope.
 * 4. Write guards throw FOLDER_LOCKED before touching a locked scope.
 * 5. Lock state is lenient about a MISSING folder_privacy table: a library
 *    opened at a pre-v61 / partial-migration schema has no protection rows,
 *    so open inspection must not throw. There is nothing to leak because no
 *    protection has been configured yet.
 */

export const FOLDER_PRIVACY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS folder_privacy (
    library_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('managed', 'linked')),
    scope_id TEXT NOT NULL,
    scope_relative_path TEXT NOT NULL,
    linked_root_id TEXT,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_algo TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (library_id, scope_kind, scope_id)
  );
`;

export const FOLDER_PRIVACY_SCHEMA_CHECKSUM = createHash('sha256')
  .update(FOLDER_PRIVACY_TABLE_SQL)
  .digest('hex');

const SCRYPT_ALGO = 'scrypt-v1';
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 64;

export interface ProtectedRootRow {
  scope_kind: 'managed' | 'linked';
  scope_id: string;
  scope_relative_path: string;
  linked_root_id: string | null;
}

export interface ResolvedScope {
  kind: 'managed' | 'linked';
  /** Stable DB/state scope id. For a linked virtual directory this is the
   *  ENCODED virtual folder id, so sibling directories can be protected
   *  independently with distinct passwords. */
  rootId: string;
  /** Path relative to the library (managed) or to the linked root (linked). */
  relativePath: string;
  /** Actual linked_folders.folder_id used for ASSET matching. */
  linkedRootId: string | null;
}

export interface PrivacyConnection {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

function hashPassword(password: string, salt: Buffer): string {
  return scryptSync(password, salt, SCRYPT_KEY_BYTES).toString('hex');
}

function newVerifier(password: string): { salt: string; hash: string; algo: string } {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  return { salt: salt.toString('hex'), hash: hashPassword(password, salt), algo: SCRYPT_ALGO };
}

function verifyPassword(password: string, saltHex: string, expectedHashHex: string): boolean {
  const expected = Buffer.from(expectedHashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function relativePathCovers(ancestor: string, descendant: string): boolean {
  if (ancestor === '') return true;
  return descendant === ancestor || descendant.startsWith(`${ancestor}/`);
}

/**
 * Lenient partial-migration libraries (and read-only inspection paths) may
 * not have the v61 table yet. Never let a missing table break an open/read.
 */
export function folderPrivacyTableExists(connection: PrivacyConnection): boolean {
  return (
    connection
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'folder_privacy'")
      .get() as { one: number } | undefined
  ) !== undefined;
}

export function readProtectedRoots(
  connection: PrivacyConnection,
  libraryId: string,
): ProtectedRootRow[] {
  if (!folderPrivacyTableExists(connection)) return [];
  return connection
    .prepare(
      `SELECT scope_kind, scope_id, scope_relative_path, linked_root_id
          FROM folder_privacy
         WHERE library_id = ?`,
    )
    .all(libraryId) as ProtectedRootRow[];
}

export function resolveScopeForFolderId(
  connection: PrivacyConnection,
  libraryId: string,
  folderId: string,
): ResolvedScope | null {
  const managed = connection
    .prepare('SELECT folder_id, relative_path FROM managed_folders WHERE folder_id = ?')
    .get(folderId) as { folder_id: string; relative_path: string } | undefined;
  if (managed) {
    return {
      kind: 'managed',
      rootId: managed.folder_id,
      relativePath: managed.relative_path,
      linkedRootId: null,
    };
  }
  const virtual = parseLinkedVirtualFolderId(folderId);
  const linkedRootId = virtual?.linkedFolderId ?? folderId;
  const relativePath = virtual?.relativePath ?? '';
  const linked = connection
    .prepare('SELECT folder_id FROM linked_folders WHERE folder_id = ? AND library_id = ?')
    .get(linkedRootId, libraryId) as { folder_id: string } | undefined;
  if (!linked) return null;
  // The linked ROOT keeps its plain folder id as scope id so it can coexist
  // with protected virtual children. Virtual children use their encoded id.
  const rootId = relativePath === '' ? linkedRootId : encodeLinkedVirtualFolderId(linkedRootId, relativePath);
  return { kind: 'linked', rootId, relativePath, linkedRootId };
}

export class FolderPrivacyStateStore {
  private readonly unlockedByLibrary = new Map<string, Set<string>>();

  private key(kind: 'managed' | 'linked', rootId: string): string {
    return `${kind}\u0000${rootId}`;
  }

  isUnlocked(libraryId: string, kind: 'managed' | 'linked', rootId: string): boolean {
    return this.unlockedByLibrary.get(libraryId)?.has(this.key(kind, rootId)) ?? false;
  }

  unlock(libraryId: string, kind: 'managed' | 'linked', rootId: string): void {
    let set = this.unlockedByLibrary.get(libraryId);
    if (!set) { set = new Set(); this.unlockedByLibrary.set(libraryId, set); }
    set.add(this.key(kind, rootId));
  }

  relock(libraryId: string, kind: 'managed' | 'linked', rootId: string): void {
    this.unlockedByLibrary.get(libraryId)?.delete(this.key(kind, rootId));
  }

  relockLibrary(libraryId: string): void {
    this.unlockedByLibrary.delete(libraryId);
  }

  clear(): void {
    this.unlockedByLibrary.clear();
  }
}

export interface LockedRoot {
  kind: 'managed' | 'linked';
  /** Stable DB/state scope id (encoded virtual id for linked children). */
  rootId: string;
  relativePath: string;
  /** Actual linked_folders.folder_id for ASSET matching. */
  linkedRootId: string | null;
  /** Linked roots mounted on this managed root or one of its descendants.
   *  Their assets are location_kind='linked' and must inherit the lock. */
  coveredLinkedRootIds: readonly string[];
}

export interface LockedRootsSql {
  sql: string;
  params: unknown[];
}

/**
 * A linked root may be mounted under a managed folder
 * (linked_folders.parent_folder_id). Resolve every such root whose mount
 * point is the locked managed root or one of its descendants. Older / partial
 * schemas may lack the column; in that case nested linked roots cannot exist.
 */
function coveredLinkedRootIds(
  connection: PrivacyConnection,
  managedRelativePath: string,
): string[] {
  const prefix = `${managedRelativePath}/`;
  try {
    const rows = connection
      .prepare(
        `SELECT lf.folder_id
           FROM linked_folders lf
           JOIN managed_folders mf ON mf.folder_id = lf.parent_folder_id
          WHERE mf.relative_path = ? OR substr(mf.relative_path, 1, ?) = ?`,
      )
      .all(managedRelativePath, prefix.length, prefix) as Array<{ folder_id: string }>;
    return rows.map((row) => row.folder_id);
  } catch {
    return [];
  }
}

export function collectLockedRoots(
  connection: PrivacyConnection,
  libraryId: string,
  state: FolderPrivacyStateStore,
): LockedRoot[] {
  const rows = readProtectedRoots(connection, libraryId);
  const locked: LockedRoot[] = [];
  for (const row of rows) {
    const kind = row.scope_kind;
    if (state.isUnlocked(libraryId, kind, row.scope_id)) continue;
    if (kind === 'managed') {
      // A managed root is anchored to a STABLE folder_id (monotonic per
      // library), never to a path. Resolve its CURRENT relative_path so a
      // rename/move of the protected folder or any ancestor is reflected
      // without touching the folder_privacy row. If the folder no longer
      // exists the root is inert (nothing can be hidden beneath it).
      const current = connection
        .prepare('SELECT relative_path FROM managed_folders WHERE folder_id = ?')
        .get(row.scope_id) as { relative_path: string } | undefined;
      if (!current) continue;
      locked.push({
        kind,
        rootId: row.scope_id,
        relativePath: current.relative_path,
        linkedRootId: null,
        coveredLinkedRootIds: coveredLinkedRootIds(connection, current.relative_path),
      });
    } else {
      // Linked roots are anchored to the stable linked_folders.folder_id.
      locked.push({
        kind,
        rootId: row.scope_id,
        relativePath: row.scope_relative_path,
        linkedRootId: row.linked_root_id ?? row.scope_id,
        coveredLinkedRootIds: [],
      });
    }
  }
  return locked;
}

export function privacyHiddenAssetsSql(
  connection: PrivacyConnection,
  libraryId: string,
  state: FolderPrivacyStateStore,
): LockedRootsSql {
  const locked = collectLockedRoots(connection, libraryId, state);
  if (locked.length === 0) {
    return { sql: '1 = 1', params: [] };
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const root of locked) {
    if (root.kind === 'managed') {
      clauses.push(
        `(a.location_kind = 'managed' AND EXISTS (
            SELECT 1 FROM managed_folders locked_mf
             WHERE locked_mf.folder_id = a.managed_folder_id
               AND (locked_mf.relative_path = ? OR substr(locked_mf.relative_path, 1, ?) = ?)
          ))`,
      );
      const prefix = root.relativePath === '' ? '' : `${root.relativePath}/`;
      params.push(root.relativePath, prefix.length, prefix);
      // Inherited linked roots: their assets are NOT location_kind='managed'.
      if (root.coveredLinkedRootIds.length > 0) {
        const placeholders = root.coveredLinkedRootIds.map(() => '?').join(', ');
        clauses.push(`(a.location_kind = 'linked' AND a.linked_folder_id IN (${placeholders}))`);
        params.push(...root.coveredLinkedRootIds);
      }
    } else {
      const linkedRootId = root.linkedRootId ?? root.rootId;
      if (root.relativePath === '') {
        clauses.push(`(a.location_kind = 'linked' AND a.linked_folder_id = ?)`);
        params.push(linkedRootId);
      } else {
        const prefix = `${root.relativePath}/`;
        clauses.push(
          `(a.location_kind = 'linked' AND a.linked_folder_id = ?
             AND (a.relative_file_path = ? OR substr(a.relative_file_path, 1, ?) = ?))`,
        );
        params.push(linkedRootId, root.relativePath, prefix.length, prefix);
      }
    }
  }
  return { sql: `NOT (${clauses.join(' OR ')})`, params };
}

export function isAssetHiddenByPrivacy(input: {
  lockedRoots: readonly LockedRoot[];
  locationKind: 'managed' | 'linked';
  managedFolderRelativePath: string | null;
  linkedFolderId: string | null;
  relativeFilePath: string;
}): boolean {
  for (const root of input.lockedRoots) {
    if (root.kind === 'managed') {
      if (input.locationKind === 'linked') {
        if (input.linkedFolderId && root.coveredLinkedRootIds.includes(input.linkedFolderId)) return true;
        continue;
      }
      const folderPath = input.managedFolderRelativePath ?? '';
      if (relativePathCovers(root.relativePath, folderPath)) return true;
    } else {
      if (input.locationKind !== 'linked') continue;
      if (input.linkedFolderId !== (root.linkedRootId ?? root.rootId)) continue;
      if (relativePathCovers(root.relativePath, input.relativeFilePath)) return true;
    }
  }
  return false;
}

/** A linked root mounted beneath a locked managed root inherits the lock. */
export function isLinkedRootHiddenByManagedPrivacy(
  lockedRoots: readonly LockedRoot[],
  linkedFolderId: string | null,
): boolean {
  if (!linkedFolderId) return false;
  return lockedRoots.some(
    (root) => root.kind === 'managed' && root.coveredLinkedRootIds.includes(linkedFolderId),
  );
}

/** True for a locked linked scope OR an inherited managed-ancestor lock. */
export function isLinkedScopeHiddenByPrivacy(
  lockedRoots: readonly LockedRoot[],
  linkedFolderId: string,
  relativePath: string,
): boolean {
  return lockedRoots.some((root) => {
    if (root.kind === 'linked') {
      return (root.linkedRootId ?? root.rootId) === linkedFolderId
        && relativePathCovers(root.relativePath, relativePath);
    }
    return root.kind === 'managed' && root.coveredLinkedRootIds.includes(linkedFolderId);
  });
}

/** Protection rows that configure a scope, or cover it via an ancestor. */
export function protectedRootsForScope(
  rows: readonly ProtectedRootRow[],
  scope: ResolvedScope,
): ProtectedRootRow[] {
  return rows.filter((row) => {
    if (row.scope_kind !== scope.kind) return false;
    if (row.scope_id === scope.rootId) return true;
    if (scope.kind !== 'linked') return false;
    const rowLinkedRootId = row.linked_root_id ?? row.scope_id;
    return rowLinkedRootId === scope.linkedRootId
      && relativePathCovers(row.scope_relative_path, scope.relativePath);
  });
}

/** Badge for a resolved folder scope; undefined when nothing is configured. */
export function folderPrivacyBadgeForScope(
  rows: readonly ProtectedRootRow[],
  libraryId: string,
  state: FolderPrivacyStateStore,
  scope: ResolvedScope,
  lockedRoots: readonly LockedRoot[] = [],
): FolderPrivacyBadge | undefined {
  const matching = protectedRootsForScope(rows, scope);
  const inherited = scope.kind === 'linked'
    && isLinkedRootHiddenByManagedPrivacy(lockedRoots, scope.linkedRootId);
  if (matching.length === 0 && !inherited) return undefined;
  const locked = inherited || matching.some(
    (row) => !state.isUnlocked(libraryId, row.scope_kind, row.scope_id),
  );
  return { protected: true, locked };
}

// Re-export the low-level crypto helpers for the LibraryService folderPrivacy
// command implementation (kept here so salt/hash logic has one home).
export const folderPrivacyCrypto = { newVerifier, verifyPassword };

export type { FolderPrivacyInput, FolderPrivacyResult, FolderPrivacyState };
