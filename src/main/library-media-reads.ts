/**
 * Track and abort Main-process reads of library files (`serpent://` streams).
 *
 * Chromium keeps those streams open while thumbnails/previews are on screen.
 * Windows then refuses to delete the library root (EPERM / ENOTEMPTY) even
 * after the Worker has closed SQLite. Blocking new reads and aborting the
 * live AbortControllers lets createReadStream drop the handles before rm.
 */

const blockedLibraryIds = new Set<string>();
const abortByLibraryId = new Map<string, AbortController>();
const fenceCountByLibraryId = new Map<string, number>();

export function isLibraryMediaReadBlocked(libraryId: string): boolean {
  return blockedLibraryIds.has(libraryId) || (fenceCountByLibraryId.get(libraryId) ?? 0) > 0;
}

export function blockLibraryMediaReads(libraryId: string): void {
  blockedLibraryIds.add(libraryId);
  const current = abortByLibraryId.get(libraryId);
  if (!current) return;
  current.abort();
  abortByLibraryId.delete(libraryId);
}

export function unblockLibraryMediaReads(libraryId: string): void {
  blockedLibraryIds.delete(libraryId);
}

/**
 * Delete-from-disk must drop Chromium file handles before Worker `rm`.
 * The fence is request-scoped: Serpent ZIP import keeps the same
 * `library_id`, so a leaked block 410s every `serpent://` URL after the
 * user re-imports that library.
 */
export function beginLibraryDeleteMediaFence(libraryId: string): void {
  fenceCountByLibraryId.set(libraryId, (fenceCountByLibraryId.get(libraryId) ?? 0) + 1);
  abortByLibraryId.get(libraryId)?.abort();
  abortByLibraryId.delete(libraryId);
}

export function endLibraryDeleteMediaFence(libraryId: string): void {
  const count = fenceCountByLibraryId.get(libraryId) ?? 0;
  if (count <= 1) fenceCountByLibraryId.delete(libraryId);
  else fenceCountByLibraryId.set(libraryId, count - 1);
}

export function bindLibraryMediaReadSignal(
  libraryId: string,
  requestSignal?: AbortSignal | null,
): AbortSignal {
  if (isLibraryMediaReadBlocked(libraryId)) {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    return requestSignal
      ? AbortSignal.any([requestSignal, alreadyAborted.signal])
      : alreadyAborted.signal;
  }

  let controller = abortByLibraryId.get(libraryId);
  if (!controller || controller.signal.aborted) {
    controller = new AbortController();
    abortByLibraryId.set(libraryId, controller);
  }
  return requestSignal
    ? AbortSignal.any([requestSignal, controller.signal])
    : controller.signal;
}
