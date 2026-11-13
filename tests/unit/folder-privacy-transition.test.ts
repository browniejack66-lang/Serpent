import { describe, expect, it, vi } from 'vitest';

import { createFolderPrivacyTransition } from '../../src/main/folder-privacy-transition';
import {
  beginLibraryDeleteMediaFence, bindLibraryMediaReadSignal,
  endLibraryDeleteMediaFence, isLibraryMediaReadBlocked,
} from '../../src/main/library-media-reads';
import type { WorkerResult } from '../../src/shared/protocol/responses';

const success: WorkerResult = { ok: true, type: 'folder.privacy', libraryId: 'library', states: [] };

describe('folder privacy transition', () => {
  it('revokes requests awaiting resolution before notifying all views', async () => {
    const oldRequest = bindLibraryMediaReadSignal('library');
    const publish = vi.fn(() => {
      expect(isLibraryMediaReadBlocked('library')).toBe(true);
      expect(oldRequest.aborted).toBe(true);
    });
    const invalidate = vi.fn();
    const transition = createFolderPrivacyTransition({
      request: async () => {
        expect(oldRequest.aborted).toBe(true);
        expect(isLibraryMediaReadBlocked('library')).toBe(true);
        return success;
      },
      beginFence: beginLibraryDeleteMediaFence, endFence: endLibraryDeleteMediaFence,
      invalidate, publish,
    });
    await transition({ type: 'folder.privacy', libraryId: 'library', folderId: 'folder', action: 'lock' });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledOnce();
    expect(isLibraryMediaReadBlocked('library')).toBe(false);
    expect(oldRequest.aborted).toBe(true);
    expect(bindLibraryMediaReadSignal('library').aborted).toBe(false);
  });

  it('serializes mutations and releases a failed transition for the next request', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstRequest = new Promise<WorkerResult>((_resolve, reject) => { rejectFirst = reject; });
    const request = vi.fn().mockImplementationOnce(() => firstRequest).mockResolvedValue(success);
    const publish = vi.fn();
    const transition = createFolderPrivacyTransition({
      request, beginFence: beginLibraryDeleteMediaFence, endFence: endLibraryDeleteMediaFence,
      invalidate: vi.fn(), publish,
    });
    const first = transition({ type: 'folder.privacy', libraryId: 'library', action: 'lock', folderId: 'folder' });
    const failed = expect(first).rejects.toThrow('worker failed');
    const second = transition({ type: 'folder.privacy', libraryId: 'library', action: 'unlock', folderId: 'folder', password: 'test' });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    rejectFirst(new Error('worker failed'));
    await failed;
    await second;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(isLibraryMediaReadBlocked('library')).toBe(false);
  });

  it('keeps overlapping deletion fences active and does not fence status reads', async () => {
    beginLibraryDeleteMediaFence('library');
    const transition = createFolderPrivacyTransition({
      request: async () => success, beginFence: beginLibraryDeleteMediaFence,
      endFence: endLibraryDeleteMediaFence, invalidate: vi.fn(), publish: vi.fn(),
    });
    try {
      await transition({ type: 'folder.privacy', libraryId: 'library', action: 'lock', folderId: 'folder' });
      expect(isLibraryMediaReadBlocked('library')).toBe(true);
    } finally { endLibraryDeleteMediaFence('library'); }
    const beginFence = vi.fn();
    const status = createFolderPrivacyTransition({ request: async () => success, beginFence,
      endFence: vi.fn(), invalidate: vi.fn(), publish: vi.fn() });
    await status({ type: 'folder.privacy', libraryId: 'library', action: 'status' });
    expect(beginFence).not.toHaveBeenCalled();
  });
});
