import * as http from 'node:http';
import * as os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createExtensionServer,
  PRIVACY_EVENTS_MAX_HOLD_MS,
  type ExtensionServer,
  type ExtensionServerOptions,
} from '../../src/main/extension-server';

const TEST_PORT = 31_000 + (process.pid % 5_000);

function startServer(overrides: Partial<ExtensionServerOptions> = {}): Promise<ExtensionServer> {
  return createExtensionServer({
    port: TEST_PORT,
    uploadStagingRoot: os.tmpdir(),
    onSaveIntent: () => {},
    onSaveUpload: async () => ({ accepted: true }),
    onListFolders: async () => ({
      ok: true,
      folders: [],
      recentBrowsedFolderIds: [],
      libraryDisplayName: 'Serpent',
    }),
    onListCollections: async () => ({
      ok: true,
      collections: [],
      libraryDisplayName: 'Serpent',
    }),
    ...overrides,
  });
}

interface PrivacyEventResponse {
  status: number;
  body: unknown;
}

function getPrivacyEvents(
  port: number,
  since: string | number,
  opts?: { origin?: string; signal?: AbortSignal },
): Promise<PrivacyEventResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/privacy-events?since=${since}`,
        method: 'GET',
        headers: opts?.origin ? { Origin: opts.origin } : {},
        signal: opts?.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function getPrivacyEventsNoQuery(
  port: number,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/privacy-events`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      })
      .on('error', reject);
  });
}

function close(server: ExtensionServer): Promise<void> {
  return new Promise((resolve) => server.server.close(() => resolve()));
}

function generationOf(body: unknown): number {
  expect(body).toBeTypeOf('object');
  const value = (body as { generation?: unknown }).generation;
  expect(typeof value).toBe('number');
  return value as number;
}

afterEach(() => {
  // Individual tests close their own servers.
});

describe('GET /privacy-events', () => {
  it('answers an initial poll then holds the next poll before any privacy change', async () => {
    const server = await startServer();
    try {
      const res = await getPrivacyEvents(server.port, 0);
      expect(res.status).toBe(200);
      expect(generationOf(res.body)).toBe(1);
      let settled = false;
      const pending = getPrivacyEvents(server.port, 1).then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(settled).toBe(false);
      server.notifyPrivacyChanged();
      expect(generationOf((await pending).body)).toBe(2);
    } finally {
      await close(server);
    }
  });

  it('holds a poll at the current generation until notifyPrivacyChanged resolves it', async () => {
    const server = await startServer();
    try {
      // The fresh baseline is 1; the next privacy change advances it to 2.
      const current = generationOf((await getPrivacyEvents(server.port, 0)).body);
      expect(current).toBe(1);

      // A poll at the current generation must be held, not answered.
      let settled = false;
      const pending = getPrivacyEvents(server.port, current).then((r) => {
        settled = true;
        return r;
      });

      // Give the event loop a tick; the request must still be in flight.
      await new Promise((r) => setTimeout(r, 60));
      expect(settled).toBe(false);

      server.notifyPrivacyChanged();
      const res = await pending;
      expect(settled).toBe(true);
      expect(res.status).toBe(200);
      expect(generationOf(res.body)).toBe(2);
    } finally {
      await close(server);
    }
  });

  it('answers immediately when since is behind the current generation', async () => {
    const server = await startServer();
    try {
      server.notifyPrivacyChanged();
      server.notifyPrivacyChanged();
      const res = await getPrivacyEvents(server.port, 0);
      expect(res.status).toBe(200);
      expect(generationOf(res.body)).toBe(3);
    } finally {
      await close(server);
    }
  });

  it('resolves every concurrent pending poll on a single notify', async () => {
    const server = await startServer();
    try {
      // Polls at the fresh baseline must be held.
      const polls = [
        getPrivacyEvents(server.port, 1),
        getPrivacyEvents(server.port, 1),
        getPrivacyEvents(server.port, 1),
      ];
      await new Promise((r) => setTimeout(r, 60));
      server.notifyPrivacyChanged();
      const results = await Promise.all(polls);
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(generationOf(res.body)).toBe(2);
      }
    } finally {
      await close(server);
    }
  });

  it('rejects a bad since value with 400', async () => {
    const server = await startServer();
    try {
      for (const bad of ['abc', '-1', '1.5', '']) {
        const res = await getPrivacyEvents(server.port, bad);
        expect(res.status).toBe(400);
      }
    } finally {
      await close(server);
    }
  });

  it('rejects a missing since value with 400', async () => {
    const server = await startServer();
    try {
      const res = await getPrivacyEventsNoQuery(server.port);
      expect(res.status).toBe(400);
    } finally {
      await close(server);
    }
  });

  it('rejects a disallowed origin with 403', async () => {
    const server = await startServer();
    try {
      const res = await getPrivacyEvents(server.port, 0, {
        origin: 'https://evil.example.com',
      });
      expect(res.status).toBe(403);
    } finally {
      await close(server);
    }
  });

  it('drops a held poll when the client disconnects (no leak, later notify is safe)', async () => {
    const server = await startServer();
    try {
      // A poll at the fresh baseline is genuinely held.
      const controller = new AbortController();
      const pending = getPrivacyEvents(server.port, 1, { signal: controller.signal }).catch(
        () => 'aborted',
      );
      await new Promise((r) => setTimeout(r, 60));
      controller.abort();
      expect(await pending).toBe('aborted');
      // Notify must not throw even though the poll was dropped.
      expect(() => server.notifyPrivacyChanged()).not.toThrow();
      // A fresh poll still works.
      const res = await getPrivacyEvents(server.port, 0);
      expect(res.status).toBe(200);
      expect(generationOf(res.body)).toBe(2);
    } finally {
      await close(server);
    }
  });

  it('drains held polls on server close without throwing or hanging the close', async () => {
    const server = await startServer();
    const controller = new AbortController();
    const pending = getPrivacyEvents(server.port, 1, { signal: controller.signal }).catch(
      () => 'closed',
    );
    await new Promise((r) => setTimeout(r, 60));
    // Close must complete even with a poll in flight.
    await Promise.race([
      close(server),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('server close hung on pending poll')), 2_000),
      ),
    ]);
    controller.abort();
    await pending;
  });

  it('exposes a bounded heartbeat hold constant', () => {
    expect(PRIVACY_EVENTS_MAX_HOLD_MS).toBeGreaterThan(0);
    expect(PRIVACY_EVENTS_MAX_HOLD_MS).toBeLessThanOrEqual(30_000);
  });
});
