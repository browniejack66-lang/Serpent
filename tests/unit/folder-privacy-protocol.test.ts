import { describe, expect, it } from 'vitest';
import { parseRendererRequest, parseWorkerRequest } from '../../src/shared/protocol/requests';
import { parseFolderPrivacyChangedEvent, parseRendererResult } from '../../src/shared/protocol/responses';

describe('folder privacy IPC boundary', () => {
  for (const transport of ['renderer', 'worker'] as const) {
    const parse = (payload: Record<string, unknown>) => transport === 'renderer'
      ? parseRendererRequest({ type: 'folder.privacy.request', libraryId: 'library-1', ...payload })
      : parseWorkerRequest({ requestId: 'privacy-request', command: { type: 'folder.privacy', libraryId: 'library-1', ...payload } });

    it(transport + ' accepts status without a folder and linked subtree mutation IDs', () => {
      expect(() => parse({ action: 'status' })).not.toThrow();
      expect(() => parse({ action: 'protect', folderId: 'lfv:linked-1/Example/Child', password: 'fixture-password' })).not.toThrow();
      expect(() => parse({ action: 'lock', folderId: 'folder-1' })).not.toThrow();
    });

    it(transport + ' rejects incomplete mutations before dispatch', () => {
      expect(() => parse({ action: 'lock' })).toThrow();
      for (const action of ['protect', 'unlock', 'remove', 'change-password']) {
        expect(() => parse({ action, folderId: 'folder-1' })).toThrow();
      }
      expect(() => parse({ action: 'change-password', folderId: 'folder-1', password: 'old' })).toThrow();
    });

    it(transport + ' rejects oversized passwords, unknown actions and extra authorization flags', () => {
      expect(() => parse({ action: 'unlock', folderId: 'folder-1', password: 'x'.repeat(1025) })).toThrow();
      expect(() => parse({ action: 'unlock', folderId: 'folder-1', password: '' })).toThrow();
      expect(() => parse({ action: 'bypass', folderId: 'folder-1' })).toThrow();
      expect(() => parse({ action: 'status', unlocked: true })).toThrow();
    });
  }

  it('never accepts password material in status results or broadcast events', () => {
    const response = { ok: true, type: 'folder.privacy', libraryId: 'library-1', states: [{ folderId: 'folder-1', locked: true }] };
    expect(parseRendererResult(response)).toEqual(response);
    expect(() => parseRendererResult({ ...response, password: 'fixture-secret' })).toThrow();
    expect(() => parseRendererResult({ ...response, states: [{ ...response.states[0], passwordHash: 'fixture-hash' }] })).toThrow();
    expect(parseFolderPrivacyChangedEvent({ type: 'folder.privacy-changed', libraryId: 'library-1' })).toEqual({ type: 'folder.privacy-changed', libraryId: 'library-1' });
    expect(() => parseFolderPrivacyChangedEvent({ type: 'folder.privacy-changed', libraryId: 'library-1', password: 'fixture-secret' })).toThrow();
  });
});
