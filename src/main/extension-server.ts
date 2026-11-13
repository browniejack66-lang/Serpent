import * as http from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Save-intent schema — JSON URL save (legacy / fallback)
// ---------------------------------------------------------------------------

const httpUrlSchema = z.string().refine(
  (url) => /^https?:\/\//.test(url),
  { message: 'URL must use http or https scheme' },
);

export const saveIntentSchema = z.strictObject({
  kind: z.enum(['image', 'video']),
  sourcePageUrl: httpUrlSchema,
  mediaUrl: httpUrlSchema,
  mediaType: z.string().optional(),
  targetFolderId: z.string().min(1).nullable().optional(),
});

export type SaveIntent = z.infer<typeof saveIntentSchema>;

/** Optional privacy summary on folder summaries (Serpent #91 / PR 92).
 * The extension never needs these flags to decide what to show — the desktop
 * has already removed protected scopes from the list — but carrying them lets
 * clients apply defence-in-depth filtering without a second request. */
export const extensionFolderSchema = z.strictObject({
  folderId: z.string().min(1),
  name: z.string().min(1),
  relativePath: z.string().min(1),
  assetCount: z.number().int().nonnegative().optional(),
  privacy: z.strictObject({
    protected: z.boolean(),
    locked: z.boolean(),
  }).optional(),
});

export type ExtensionFolderSummary = z.infer<typeof extensionFolderSchema>;

export type ListFoldersDisposition =
  | {
      ok: true;
      folders: ExtensionFolderSummary[];
      recentBrowsedFolderIds: string[];
      libraryDisplayName: string;
      /** Confirmed privacy state revision. `null` means "unconfirmed" and
       * clients MUST fail closed. Optional in TS for backwards compatibility;
       * the HTTP response always emits the field. */
      privacyRevision?: string | null;
    }
  | { ok: false; status: number; reason: string };

export interface ExtensionCollectionSummary {
  collectionId: string;
  name: string;
  relativePath: string;
  assetCount?: number;
}

export type ListCollectionsDisposition =
  | {
      ok: true;
      collections: ExtensionCollectionSummary[];
      libraryDisplayName: string;
      /** See ListFoldersDisposition. Always emitted by the HTTP response. */
      privacyRevision?: string | null;
    }
  | { ok: false; status: number; reason: string };

/** 合集树用 `/` 分段。名称里的斜杠换成全角，避免被拆成额外层级。 */
export function extensionCollectionSummaries(
  collections: readonly {
    collectionId: string;
    parentId: string | null;
    name: string;
    assetCount?: number;
  }[],
): ExtensionCollectionSummary[] {
  const byId = new Map(collections.map((collection) => [collection.collectionId, collection]));
  const memo = new Map<string, string>();
  const segment = (name: string): string => {
    const safe = name.trim().replace(/[\\/]/g, '／');
    return safe.length > 0 ? safe : '未命名合集';
  };
  const pathOf = (collectionId: string, stack: Set<string>): string => {
    const cached = memo.get(collectionId);
    if (cached) return cached;
    const collection = byId.get(collectionId);
    if (!collection) return '未命名合集';
    const own = segment(collection.name);
    if (stack.has(collectionId) || !collection.parentId || !byId.has(collection.parentId)) {
      memo.set(collectionId, own);
      return own;
    }
    stack.add(collectionId);
    const path = `${pathOf(collection.parentId, stack)}/${own}`;
    stack.delete(collectionId);
    memo.set(collectionId, path);
    return path;
  };

  return collections.map((collection) => ({
    collectionId: collection.collectionId,
    name: segment(collection.name),
    relativePath: pathOf(collection.collectionId, new Set()),
    ...(typeof collection.assetCount === 'number' && Number.isFinite(collection.assetCount)
      ? { assetCount: Math.max(0, Math.floor(collection.assetCount)) }
      : {}),
  }));
}

/** Metadata for browser-fetched binary uploads (Serpent-1jyi). */
export interface SaveUploadRequest {
  kind: 'image' | 'video';
  sourcePageUrl?: string;
  mediaUrl?: string;
  contentType: string;
  filename: string;
  stagedFilePath: string;
  stagingDirectory: string;
  targetFolderId?: string | null;
  /** 设置后文件固定进资源库根目录，导入成功后再加入该合集。 */
  targetCollectionId?: string;
  byteLength: number;
  focusAppAfterSave: boolean;
  revealInLibrary: boolean;
}

export type SaveUploadDisposition =
  | { accepted: true }
  | { accepted: false; status: number; reason: string };

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export interface ExtensionServerOptions {
  /** Starting port (default 19876). Falls back to port+1, port+2 on EADDRINUSE. */
  port?: number;
  /**
   * Directory used to stage browser-uploaded media before Worker import.
   * Typically `app.getPath('temp')`.
   */
  uploadStagingRoot: string;
  /** Called with the validated save intent on POST /save. */
  onSaveIntent: (
    intent: SaveIntent,
  ) => void | SaveIntentDisposition | Promise<void | SaveIntentDisposition>;
  /** Called after POST /save-upload streams the body to a local staging file. */
  onSaveUpload: (
    upload: SaveUploadRequest,
  ) => void | SaveUploadDisposition | Promise<void | SaveUploadDisposition>;
  /** Called on GET /folders. */
  onListFolders: () => ListFoldersDisposition | Promise<ListFoldersDisposition>;
  /** Called on GET /collections. */
  onListCollections: () => ListCollectionsDisposition | Promise<ListCollectionsDisposition>;
  /** Optional error callback for server-level errors (e.g. bind failure). */
  onError?: (error: Error) => void;
}

export type SaveIntentDisposition =
  | { accepted: true }
  | { accepted: false; status: number; reason: string };

export interface ExtensionServer {
  server: http.Server;
  port: number;
  /**
   * Signal that the folder-privacy state changed (protect / unlock / lock /
   * remove / change-password). Bumps an opaque monotonic generation and
   * resolves every pending GET /privacy-events long-poll immediately, so an
   * extension watcher can invalidate cached menus + recents within a moment
   * instead of waiting for its 30s connection alarm.
   *
   * The generation is an integer with NO folder ids or library ids — it
   * reveals nothing about which folder changed.
   */
  notifyPrivacyChanged: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '127.0.0.1' || addr === '::1') return true;
  // Windows / dual-stack Node may report IPv4 loopback clients as IPv4-mapped IPv6.
  if (addr === '::ffff:127.0.0.1') return true;
  return false;
}

function isAllowedOrigin(origin: string | string[] | undefined): boolean {
  // Chromium MV3 service-worker fetches may omit Origin. Any explicit browser
  // Origin must be a real unpacked/store-installed extension origin:
  // - Chromium: chrome-extension://<32 lowercase a-p chars>
  // - Firefox:  moz-extension://<UUID> (Serpent-54122a)
  // Auth is loopback-only (product decision: no pairing token — Serpent-1cxv).
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  if (/^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) return true;
  return /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(origin);
}

const MAX_SAVE_JSON_BYTES = 16 * 1024;
/** Same cap as Worker remote download (500 MB). */
export const MAX_EXTENSION_UPLOAD_BYTES = 500 * 1024 * 1024;
const UPLOAD_STAGE_PREFIX = 'serpent-ext-upload-';

/**
 * Upper bound on how long a GET /privacy-events long-poll may be held open
 * before answering with the current generation (heartbeat). Keeps a polite
 * client from holding a socket forever and lets it detect a dead server.
 */
export const PRIVACY_EVENTS_MAX_HOLD_MS = 20_000;

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

function decodeHeaderText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseBooleanHeader(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return defaultValue;
}

function parseUploadMetadata(headers: http.IncomingHttpHeaders):
  | {
    ok: true;
    kind: 'image' | 'video';
    sourcePageUrl?: string;
    mediaUrl?: string;
    contentType: string;
    filename: string;
    targetFolderId?: string | null;
    targetCollectionId?: string;
    focusAppAfterSave: boolean;
    revealInLibrary: boolean;
  }
  | { ok: false; reason: string } {
  const kindRaw = headerValue(headers, 'x-serpent-kind');
  const sourcePageUrl = decodeHeaderText(headerValue(headers, 'x-serpent-source-page-url'));
  const mediaUrl = decodeHeaderText(headerValue(headers, 'x-serpent-media-url'));
  const localFileUpload = headerValue(headers, 'x-serpent-local-file') === 'true';
  const contentType = normalizeContentType(
    headerValue(headers, 'x-serpent-content-type') ?? headerValue(headers, 'content-type'),
  );
  const filename = decodeHeaderText(headerValue(headers, 'x-serpent-filename')) ?? 'download';
  const targetRaw = headerValue(headers, 'x-serpent-target-folder-id');
  const collectionRaw = headerValue(headers, 'x-serpent-target-collection-id');

  if (kindRaw !== 'image' && kindRaw !== 'video') {
    return { ok: false, reason: 'invalid kind' };
  }
  if (!localFileUpload && (!sourcePageUrl || !/^https?:\/\//.test(sourcePageUrl))) {
    return { ok: false, reason: 'invalid source page url' };
  }
  if (!localFileUpload && (!mediaUrl || !/^https?:\/\//.test(mediaUrl))) {
    return { ok: false, reason: 'invalid media url' };
  }
  if (localFileUpload && (sourcePageUrl !== undefined || mediaUrl !== undefined)) {
    return { ok: false, reason: 'invalid local file metadata' };
  }
  if (!contentType || contentType === 'application/octet-stream') {
    // octet-stream alone is too vague; require an explicit media content-type header.
    if (!headerValue(headers, 'x-serpent-content-type')) {
      return { ok: false, reason: 'missing content type' };
    }
  }
  if (!contentType) {
    return { ok: false, reason: 'missing content type' };
  }

  let targetFolderId: string | null | undefined;
  if (targetRaw === undefined || targetRaw === '') {
    targetFolderId = undefined;
  } else if (targetRaw === 'null') {
    targetFolderId = null;
  } else {
    targetFolderId = decodeHeaderText(targetRaw);
  }

  return {
    ok: true,
    kind: kindRaw,
    sourcePageUrl,
    mediaUrl,
    contentType,
    filename: filename.trim() || 'download',
    targetFolderId,
    ...(decodeHeaderText(collectionRaw)?.trim()
      ? { targetCollectionId: decodeHeaderText(collectionRaw)!.trim() }
      : {}),
    focusAppAfterSave: parseBooleanHeader(
      headerValue(headers, 'x-serpent-focus-app-after-save'),
      true,
    ),
    revealInLibrary: parseBooleanHeader(
      headerValue(headers, 'x-serpent-reveal-in-library'),
      true,
    ),
  };
}

function normalizeContentType(value: string | undefined): string {
  return value?.split(';')[0]?.trim().toLowerCase() ?? '';
}

function sizeLimitTransform(maxBytes: number): {
  stream: Transform;
  getByteLength: () => number;
} {
  let byteLength = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        callback(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
      callback(null, chunk);
    },
  });
  return { stream, getByteLength: () => byteLength };
}

// ---------------------------------------------------------------------------
// createExtensionServer
// ---------------------------------------------------------------------------

/**
 * Starts a lightweight HTTP server bound to 127.0.0.1. Accepts:
 *
 *   GET  /ping          → 200 {"app":"Serpent"}
 *   GET  /folders       → 200 {"folders":[...]} on success
 *   GET  /collections   → 200 {"collections":[...]} on success
 *   GET  /privacy-events?since=<n> → long-poll; resolves to {"generation":N}
 *                          as soon as the privacy generation advances past <n>,
 *                          or after a bounded heartbeat timeout. Opaque ints.
 *   POST /save          → 202 on valid save-intent JSON (desktop re-download)
 *   POST /save-upload   → 202 after browser-fetched bytes are staged (preferred)
 *
 * Only loopback connections (127.0.0.1, ::1) are accepted. No pairing token
 * (Serpent-1cxv): identity is loopback + optional chrome-extension Origin.
 */
export async function createExtensionServer(
  options: ExtensionServerOptions,
): Promise<ExtensionServer> {
  const startPort = options.port ?? 19876;
  const maxPort = startPort + 2;

  // Start above the client baseline so its first poll responds immediately;
  // subsequent polls at this generation wait, even before any privacy change.
  // No folder or library identity is ever encoded.
  let privacyGeneration = 1;
  interface PendingPrivacyPoll {
    res: http.ServerResponse;
    timer: NodeJS.Timeout;
  }
  const pendingPrivacyPolls = new Set<PendingPrivacyPoll>();

  function respondPrivacyGeneration(res: http.ServerResponse): void {
    if (res.writableEnded || res.destroyed) return;
    jsonResponse(res, 200, { status: 'ok', generation: privacyGeneration });
  }

  function settlePrivacyPoll(poll: PendingPrivacyPoll): void {
    clearTimeout(poll.timer);
    pendingPrivacyPolls.delete(poll);
    respondPrivacyGeneration(poll.res);
  }

  const notifyPrivacyChanged = (): void => {
    privacyGeneration += 1;
    for (const poll of [...pendingPrivacyPolls]) {
      settlePrivacyPoll(poll);
    }
  };

  const server = http.createServer((req, res) => {
    res.setHeader('Connection', 'close');

    req.on('error', () => {
      // No-op: the socket will be destroyed automatically by Node.
    });

    if (!isLoopback(req.socket.remoteAddress)) {
      jsonResponse(res, 403, { status: 'rejected', reason: 'forbidden' });
      return;
    }

    if (req.method === 'GET' && req.url === '/ping') {
      jsonResponse(res, 200, { app: 'Serpent' });
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/privacy-events')) {
      if (!isAllowedOrigin(req.headers.origin)) {
        jsonResponse(res, 403, { status: 'rejected', reason: 'forbidden origin' });
        req.resume();
        return;
      }

      let query: URLSearchParams;
      try {
        query = new URL(req.url, 'http://127.0.0.1').searchParams;
      } catch {
        jsonResponse(res, 400, { status: 'rejected', reason: 'invalid query' });
        req.resume();
        return;
      }
      const rawSince = query.get('since');
      const trimmed = rawSince === null ? '' : rawSince.trim();
      const since = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
      if (!Number.isInteger(since) || since < 0) {
        jsonResponse(res, 400, { status: 'rejected', reason: 'invalid since' });
        req.resume();
        return;
      }

      // A new client or a client from a previous server instance gets the
      // current baseline immediately. Only matching generations are held.
      if (since !== privacyGeneration) {
        respondPrivacyGeneration(res);
        return;
      }

      // Hold until the generation advances or the heartbeat timeout fires.
      const poll: PendingPrivacyPoll = {
        res,
        timer: setTimeout(() => settlePrivacyPoll(poll), PRIVACY_EVENTS_MAX_HOLD_MS),
      };
      // Do not keep the event loop alive solely for a held poll.
      poll.timer.unref();
      pendingPrivacyPolls.add(poll);
      // Drop the poll if the client disconnects before it is answered.
      res.on('close', () => {
        clearTimeout(poll.timer);
        pendingPrivacyPolls.delete(poll);
      });
      req.resume();
      return;
    }

    if (req.method === 'GET' && req.url === '/folders') {
      if (!isAllowedOrigin(req.headers.origin)) {
        jsonResponse(res, 403, { status: 'rejected', reason: 'forbidden origin' });
        req.resume();
        return;
      }

      void Promise.resolve(options.onListFolders())
        .then((disposition) => {
          if (!disposition.ok) {
            jsonResponse(res, disposition.status, {
              status: 'rejected',
              reason: disposition.reason,
            });
            return;
          }
          jsonResponse(res, 200, {
            status: 'ok',
            folders: disposition.folders,
            recentBrowsedFolderIds: disposition.recentBrowsedFolderIds,
            libraryDisplayName: disposition.libraryDisplayName,
            // Always present: an old desktop build that does not set it yields
            // null, which new extensions treat as unconfirmed and fail closed.
            privacyRevision: disposition.privacyRevision ?? null,
          });
        })
        .catch((error) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          options.onError?.(normalized);
          jsonResponse(res, 500, { status: 'rejected', reason: 'internal error' });
        });
      return;
    }

    if (req.method === 'GET' && req.url === '/collections') {
      if (!isAllowedOrigin(req.headers.origin)) {
        jsonResponse(res, 403, { status: 'rejected', reason: 'forbidden origin' });
        req.resume();
        return;
      }

      void Promise.resolve(options.onListCollections())
        .then((disposition) => {
          if (!disposition.ok) {
            jsonResponse(res, disposition.status, {
              status: 'rejected',
              reason: disposition.reason,
            });
            return;
          }
          jsonResponse(res, 200, {
            status: 'ok',
            collections: disposition.collections,
            libraryDisplayName: disposition.libraryDisplayName,
            privacyRevision: disposition.privacyRevision ?? null,
          });
        })
        .catch((error) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          options.onError?.(normalized);
          jsonResponse(res, 500, { status: 'rejected', reason: 'internal error' });
        });
      return;
    }

    if (req.method === 'POST' && req.url === '/save-upload') {
      if (!isAllowedOrigin(req.headers.origin)) {
        jsonResponse(res, 403, { status: 'rejected', reason: 'forbidden origin' });
        req.resume();
        return;
      }

      const metadata = parseUploadMetadata(req.headers);
      if (!metadata.ok) {
        jsonResponse(res, 400, { status: 'rejected', reason: metadata.reason });
        req.resume();
        return;
      }

      const declaredLength = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_EXTENSION_UPLOAD_BYTES) {
        jsonResponse(res, 413, { status: 'rejected', reason: 'payload too large' });
        req.resume();
        return;
      }
      if (Number.isFinite(declaredLength) && declaredLength <= 0) {
        jsonResponse(res, 400, { status: 'rejected', reason: 'empty body' });
        req.resume();
        return;
      }

      void (async () => {
        const stagingDirectory = path.join(
          options.uploadStagingRoot,
          `${UPLOAD_STAGE_PREFIX}${randomUUID()}`,
        );
        const safeName =
          path.basename(metadata.filename).replace(
            // eslint-disable-next-line no-control-regex -- strip illegal filename chars
            /[<>:"/\\|?*\u0000-\u001f]/g,
            '_',
          ) || 'download';
        const stagedFilePath = path.join(stagingDirectory, safeName);
        try {
          await mkdir(stagingDirectory, { recursive: true });
          const limit = sizeLimitTransform(MAX_EXTENSION_UPLOAD_BYTES);
          const writer = createWriteStream(stagedFilePath, { flags: 'wx', mode: 0o600 });
          await pipeline(req, limit.stream, writer);
          const byteLength = limit.getByteLength();
          if (byteLength === 0) {
            await rm(stagingDirectory, { recursive: true, force: true });
            jsonResponse(res, 400, { status: 'rejected', reason: 'empty body' });
            return;
          }

          const disposition = await options.onSaveUpload({
            kind: metadata.kind,
            contentType: metadata.contentType,
            filename: safeName,
            stagedFilePath,
            stagingDirectory,
            targetFolderId: metadata.targetFolderId,
            ...(metadata.targetCollectionId
              ? { targetCollectionId: metadata.targetCollectionId }
              : {}),
            byteLength,
            focusAppAfterSave: metadata.focusAppAfterSave,
            revealInLibrary: metadata.revealInLibrary,
            ...(metadata.sourcePageUrl === undefined
              ? {}
              : { sourcePageUrl: metadata.sourcePageUrl }),
            ...(metadata.mediaUrl === undefined ? {} : { mediaUrl: metadata.mediaUrl }),
          });

          if (
            disposition &&
            typeof disposition === 'object' &&
            'accepted' in disposition &&
            !disposition.accepted
          ) {
            jsonResponse(res, disposition.status, {
              status: 'rejected',
              reason: disposition.reason,
            });
            return;
          }

          jsonResponse(res, 202, { status: 'accepted' });
        } catch (error) {
          try {
            await rm(stagingDirectory, { recursive: true, force: true });
          } catch {
            // Best effort.
          }
          const normalized = error instanceof Error ? error : new Error(String(error));
          if ((normalized as NodeJS.ErrnoException).code === 'PAYLOAD_TOO_LARGE') {
            jsonResponse(res, 413, { status: 'rejected', reason: 'payload too large' });
            return;
          }
          options.onError?.(normalized);
          if (!res.headersSent) {
            jsonResponse(res, 500, { status: 'rejected', reason: 'internal error' });
          }
        }
      })();
      return;
    }

    if (req.method === 'POST' && req.url === '/save') {
      if (!isAllowedOrigin(req.headers.origin)) {
        jsonResponse(res, 403, { status: 'rejected', reason: 'forbidden origin' });
        req.resume();
        return;
      }
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        jsonResponse(res, 400, { status: 'rejected', reason: 'invalid content-type' });
        return;
      }

      const declaredLength = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SAVE_JSON_BYTES) {
        jsonResponse(res, 413, { status: 'rejected', reason: 'payload too large' });
        req.resume();
        return;
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let rejectedForSize = false;
      req.on('data', (chunk: Buffer) => {
        if (rejectedForSize) return;
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_SAVE_JSON_BYTES) {
          rejectedForSize = true;
          chunks.length = 0;
          jsonResponse(res, 413, { status: 'rejected', reason: 'payload too large' });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (rejectedForSize) return;
        const raw = Buffer.concat(chunks).toString('utf-8');

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          jsonResponse(res, 400, { status: 'rejected', reason: 'invalid json' });
          return;
        }

        const result = saveIntentSchema.safeParse(parsed);
        if (!result.success) {
          jsonResponse(res, 400, { status: 'rejected', reason: 'invalid body' });
          return;
        }

        try {
          const disposition = await options.onSaveIntent(result.data);
          if (
            disposition &&
            typeof disposition === 'object' &&
            'accepted' in disposition &&
            !disposition.accepted
          ) {
            jsonResponse(res, disposition.status, {
              status: 'rejected',
              reason: disposition.reason,
            });
            return;
          }
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          options.onError?.(normalized);
          jsonResponse(res, 500, { status: 'rejected', reason: 'internal error' });
          return;
        }

        jsonResponse(res, 202, { status: 'accepted' });
      });
      return;
    }

    jsonResponse(res, 404, { status: 'rejected', reason: 'not found' });
  });

  // Drain held long-polls before close so no timer leaks and held sockets are
  // released (otherwise server.close() waits forever on a held connection).
  const drainPendingPrivacyPolls = (): void => {
    for (const poll of [...pendingPrivacyPolls]) {
      clearTimeout(poll.timer);
      pendingPrivacyPolls.delete(poll);
      try {
        if (!poll.res.writableEnded && !poll.res.destroyed) {
          poll.res.end();
        }
      } catch {
        // Ignore: the socket may already be gone.
      }
    }
  };
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    drainPendingPrivacyPolls();
    return originalClose(callback);
  }) as typeof server.close;
  // Belt and braces: a close triggered by another path also drains timers.
  server.on('close', drainPendingPrivacyPolls);

  for (let port = startPort; port <= maxPort; port++) {
    try {
      const boundPort = await new Promise<number>((resolve, reject) => {
        function onError(err: NodeJS.ErrnoException) {
          reject(err);
        }
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolve(port);
        });
      });
      return { server, port: boundPort, notifyPrivacyChanged };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        options.onError?.(err as Error);
        throw err;
      }
    }
  }

  const finalError = new Error(
    `Failed to bind extension server to any port in range ${startPort}-${maxPort}`,
  );
  options.onError?.(finalError);
  throw finalError;
}
