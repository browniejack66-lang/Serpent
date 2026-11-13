import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../src/main/app-logger';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: class { constructor() { return mocks.create(); } },
}));
import { renderDocumentThumbnail } from '../../src/main/document-thumbnail-renderer';

const request = { type: 'document-thumbnail.render-request' as const, requestId: 'request', url: 'serpent://source/library/asset', width: 1024 };
const logger = { error: vi.fn() } as unknown as AppLogger;

describe('document thumbnail privacy revocation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not create a window for an already revoked read', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await renderDocumentThumbnail(request, logger, controller.signal)).toMatchObject({ status: 'failed', errorCode: 'DOCUMENT_RENDER_ABORTED' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('destroys a loading window and never captures after relocking', async () => {
    const controller = new AbortController();
    let rejectLoad!: (error: Error) => void;
    let destroyed = false;
    const capturePage = vi.fn();
    const destroy = vi.fn(() => { destroyed = true; rejectLoad(new Error('window destroyed')); });
    mocks.create.mockReturnValue({
      loadURL: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLoad = reject; })),
      destroy, isDestroyed: () => destroyed,
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn(), capturePage },
    });
    const rendering = renderDocumentThumbnail(request, logger, controller.signal);
    controller.abort();
    expect(await rendering).toMatchObject({ status: 'failed', errorCode: 'DOCUMENT_RENDER_ABORTED' });
    expect(destroy).toHaveBeenCalled();
    expect(capturePage).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
