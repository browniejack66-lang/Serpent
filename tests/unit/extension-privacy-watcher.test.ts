import { describe, expect, it } from 'vitest';

import {
  fetchPrivacyEvents,
  startPrivacyWatcher,
  type WatcherFetch,
} from '../../extension/privacy-events';

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(body);
    },
  };
}

/** A scripted fetch that returns the queued results in order, then repeats last. */
function scriptedFetch(
  script: Array<{ gen: number } | { status: number } | 'throw'>,
): { fetchFn: WatcherFetch; calls: () => number } {
  let index = 0;
  let count = 0;
  const fetchFn: WatcherFetch = async () => {
    count += 1;
    const step = script[Math.min(index, script.length - 1)] ?? 'throw';
    index += 1;
    // Yield a macrotask so a fast-resolving fetch cannot starve the test's
    // driving loop (mirrors real network latency giving control back).
    await new Promise((r) => setTimeout(r, 0));
    if (step === 'throw') throw new Error('offline');
    if ('status' in step) return jsonResponse({ status: 'rejected' }, step.status);
    return jsonResponse({ status: 'ok', generation: step.gen });
  };
  return { fetchFn, calls: () => count };
}

/** Deterministic delay that yields a macrotask so the loop cannot starve timers. */
function immediateDelay(record?: (ms: number) => void) {
  return async (ms: number): Promise<void> => {
    record?.(ms);
    await new Promise((r) => setTimeout(r, 0));
  };
}

describe('fetchPrivacyEvents', () => {
  it('parses a valid generation from a 200 response', async () => {
    const outcome = await fetchPrivacyEvents(7, async () =>
      jsonResponse({ status: 'ok', generation: 9 }),
    );
    expect(outcome).toEqual({ kind: 'ok', generation: 9 });
  });

  it('reports rejected on a non-200 status', async () => {
    const outcome = await fetchPrivacyEvents(0, async () =>
      jsonResponse({ status: 'rejected' }, 403),
    );
    expect(outcome).toEqual({ kind: 'rejected', status: 403 });
  });

  it('treats a malformed generation as rejected', async () => {
    const outcome = await fetchPrivacyEvents(0, async () =>
      jsonResponse({ status: 'ok', generation: -1 }),
    );
    expect(outcome.kind).toBe('rejected');
  });

  it('reports unreachable when every fallback port throws', async () => {
    const fetchFn: WatcherFetch = async () => {
      throw new Error('offline');
    };
    const outcome = await fetchPrivacyEvents(0, fetchFn);
    expect(outcome).toEqual({ kind: 'unreachable' });
  });

  it('falls back to the next port when the first throws', async () => {
    let call = 0;
    const fetchFn: WatcherFetch = async () => {
      call += 1;
      if (call === 1) throw new Error('port busy');
      return jsonResponse({ status: 'ok', generation: 3 });
    };
    const outcome = await fetchPrivacyEvents(0, fetchFn);
    expect(outcome).toEqual({ kind: 'ok', generation: 3 });
    expect(call).toBeGreaterThanOrEqual(2);
  });
});

describe('startPrivacyWatcher', () => {
  it('fires onPrivacyChanged when the generation advances then stops advancing', async () => {
    const { fetchFn } = scriptedFetch([{ gen: 1 }, { gen: 1 }, { gen: 2 }, { gen: 2 }]);
    const changed: number[] = [];
    let stopRef: (() => void) | null = null;
    const watcher = startPrivacyWatcher({
      fetchFn,
      delay: immediateDelay(),
      onPrivacyChanged: (gen) => {
        changed.push(gen);
        if (changed.length === 2) stopRef?.();
      },
    });
    stopRef = watcher.stop;
    // Let the loop spin a bounded number of turns.
    for (let i = 0; i < 50 && changed.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    watcher.stop();
    await watcher.done;
    expect(changed).toEqual([1, 2]);
  });

  it('does not fire onPrivacyChanged on an unchanged heartbeat generation', async () => {
    const { fetchFn } = scriptedFetch([{ gen: 5 }, { gen: 5 }, { gen: 5 }]);
    const changed: number[] = [];
    const watcher = startPrivacyWatcher({
      fetchFn,
      delay: immediateDelay(),
      onPrivacyChanged: (gen) => changed.push(gen),
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    watcher.stop();
    await watcher.done;
    expect(changed).toEqual([5]);
  });

  it('backs off on unreachable and reports disconnect once', async () => {
    const { fetchFn } = scriptedFetch(['throw']);
    const delays: number[] = [];
    let disconnected = 0;
    const watcher = startPrivacyWatcher({
      fetchFn,
      baseBackoffMs: 10,
      maxBackoffMs: 40,
      delay: immediateDelay((ms) => delays.push(ms)),
      onDisconnected: () => {
        disconnected += 1;
      },
      onPrivacyChanged: () => {},
    });
    // Note: onDisconnected only fires after we were connected; never connected
    // here, so it stays 0. We drive enough turns to observe growing backoff.
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
    watcher.stop();
    await watcher.done;
    expect(disconnected).toBe(0);
    // Backoff doubles from 10 up to the 40 cap.
    expect(delays.length).toBeGreaterThan(2);
    expect(Math.max(...delays)).toBe(40);
  });

  it('reports disconnect after losing a previously healthy connection', async () => {
    // Connect (gen 0), then go offline.
    let call = 0;
    const fetchFn: WatcherFetch = async () => {
      call += 1;
      await new Promise((r) => setTimeout(r, 0));
      if (call <= 1) return jsonResponse({ status: 'ok', generation: 0 });
      throw new Error('offline');
    };
    let disconnected = 0;
    const watcher = startPrivacyWatcher({
      fetchFn,
      baseBackoffMs: 5,
      maxBackoffMs: 10,
      delay: immediateDelay(),
      onPrivacyChanged: () => {},
      onDisconnected: () => {
        disconnected += 1;
      },
    });
    for (let i = 0; i < 30 && disconnected === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    watcher.stop();
    await watcher.done;
    expect(disconnected).toBe(1);
  });

  it('stop() is idempotent and aborts a held fetch', async () => {
    let resolveFetch: () => void = () => {};
    const fetchFn: WatcherFetch = (_input: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        resolveFetch = () => resolve(jsonResponse({ status: 'ok', generation: 1 }));
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const watcher = startPrivacyWatcher({
      fetchFn,
      delay: immediateDelay(),
      onPrivacyChanged: () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    // In-flight fetch is pending; stop should abort it and let done resolve.
    watcher.stop();
    watcher.stop();
    await Promise.race([
      watcher.done,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('watcher did not stop')), 2_000),
      ),
    ]);
    resolveFetch();
  });

  it('resumes delivering changes after a reconnect', async () => {
    // gen 1, offline, then gen 2.
    let call = 0;
    const fetchFn: WatcherFetch = async () => {
      call += 1;
      await new Promise((r) => setTimeout(r, 0));
      if (call === 1) return jsonResponse({ status: 'ok', generation: 1 });
      if (call <= 4) throw new Error('offline');
      return jsonResponse({ status: 'ok', generation: 2 });
    };
    const changed: number[] = [];
    const events: string[] = [];
    const watcher = startPrivacyWatcher({
      fetchFn,
      baseBackoffMs: 5,
      maxBackoffMs: 10,
      delay: immediateDelay(),
      onPrivacyChanged: (gen) => changed.push(gen),
      onDisconnected: () => events.push('disconnected'),
      onReconnected: () => events.push('reconnected'),
    });
    for (let i = 0; i < 80 && changed.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    watcher.stop();
    await watcher.done;
    expect(changed).toEqual([1, 2]);
    expect(events).toContain('disconnected');
    expect(events).toContain('reconnected');
  });
});
