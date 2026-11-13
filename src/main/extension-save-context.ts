import type { ActiveContext } from "../shared/protocol/requests";

export type ExtensionSaveContext = {
  readonly libraryId: string;
  readonly selectedFolderId?: string;
};

export type ExtensionSaveRouting = {
  readonly context: ExtensionSaveContext | null;
  readonly targetWindowId: number | null;
};

/**
 * Picks which library/folder the browser extension should target.
 *
 * Focused-window routing matches multi-window expectations while Serpent is
 * frontmost. When the user saves from a browser tab, no Electron window is
 * focused — fall back to the last Serpent window that published context.
 */
export function resolveExtensionSaveRouting(input: {
  readonly focusedWindowId: number | null;
  readonly contexts: ReadonlyMap<number, ActiveContext>;
  readonly lastTargetWindowId: number | null;
  readonly mainWindowId: number | null;
}): ExtensionSaveRouting {
  const pick = (
    windowId: number | null | undefined,
  ): ExtensionSaveRouting | null => {
    if (windowId == null) return null;
    const context = input.contexts.get(windowId);
    if (!context?.libraryId) return null;
    return {
      targetWindowId: windowId,
      context: {
        libraryId: context.libraryId,
        selectedFolderId: context.selectedFolderId,
      },
    };
  };

  return (
    pick(input.focusedWindowId) ??
    pick(input.lastTargetWindowId) ??
    pick(input.mainWindowId) ?? { context: null, targetWindowId: null }
  );
}

export function resolveExtensionSaveContext(input: {
  readonly focusedWindowId: number | null;
  readonly contexts: ReadonlyMap<number, ActiveContext>;
  readonly lastTargetWindowId: number | null;
  readonly mainWindowId: number | null;
}): ExtensionSaveContext | null {
  return resolveExtensionSaveRouting(input).context;
}

/**
 * Serpent #91 / PR 92: true when the desktop-selected save target belongs to
 * a protected scope (root or any descendant). Callers MUST reject the save and
 * ask for a new target — never silently fall back to the library root.
 */
export function extensionSaveContextHidden(
  context: ExtensionSaveContext | null | undefined,
  hiddenFolderIds: ReadonlySet<string>,
): boolean {
  if (!context) return false;
  const selectedFolderId = context.selectedFolderId;
  if (typeof selectedFolderId !== 'string' || selectedFolderId.length === 0) return false;
  return hiddenFolderIds.has(selectedFolderId);
}
