import { SERPENT_PORTS } from './save-client';

const SERPENT_HOST = 'http://127.0.0.1';

/** Minimal fetch surface so tests can inject a fake transport. */
type WatcherFetchResponse = {
  status: number;
  ok: boolean;
  text(): Promise<string>;
};
export type WatcherFetch = (
  input: string,
  init?: RequestInit,
) => Promise<WatcherFetchResponse>;

export type PrivacyEventOutcome =
  | { kind: 'ok'; generation: number }
  | { kind: 'rejected'; status: number }
  | { kind: 'unreachable' };

/**
 * Poll the desktop long-poll endpoint once.
 *
 * `since` is the last generation the watcher observed. The server either
 * answers immediately (its generation is already ahead) or holds the
 * connection until it advances (or a bounded heartbeat fires). Any transport
 * failure across all fallback ports is reported as `unreachable` so the
 * watcher can back off without busy-looping.
 */
export async function fetchPrivacyEvents(
  since: number,
  fetchFn: WatcherFetch = fetch,
  signal?: AbortSignal,
): Promise<PrivacyEventOutcome> {
  for (const port of SERPENT_PORTS) {
    // Honour an abort before starting another attempt (the caller may have
    // stopped the watcher between ports).
    if (signal?.aborted) return { kind: 'unreachable' };
    let response: WatcherFetchResponse;
    try {
      response = await fetchFn(
        `${SERPENT_HOST}:${port}/privacy-events?since=${since}`,
        { method: 'GET', signal },
      );
    } catch {
      // Serpent may have selected the next fallback port, or the request was
      // aborted — either way try the next port unless we were aborted.
      if (signal?.aborted) return { kind: 'unreachable' };
      continue;
    }
    if (response.status !== 200) {
      return { kind: 'rejected', status: response.status };
    }
    let body: string;
    try {
      body = await response.text();
    } catch {
      return { kind: 'rejected', status: response.status };
    }
    const generation = parseGeneration(body);
    if (generation === null) return { kind: 'rejected', status: response.status };
    return { kind: 'ok', generation };
  }
  return { kind: 'unreachable' };
}

function parseGeneration(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const value = Reflect.get(parsed, 'generation');
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    return value;
  } catch {
    return null;
  }
}

export interface PrivacyWatcherOptions {
  /** Called when the desktop generation advances (opaque; no ids). */
  onPrivacyChanged: (generation: number) => void;
  /** Called once when a previously-connected watcher loses the desktop. */
  onDisconnected?: () => void;
  /** Called when the watcher (re)establishes contact after a gap. */
  onReconnected?: () => void;
  fetchFn?: WatcherFetch;
  /** Initial backoff when the desktop is unreachable (ms). Doubles up to max. */
  baseBackoffMs?: number;
  /** Maximum backoff between reconnect attempts (ms). */
  maxBackoffMs?: number;
  /** Injectable sleep for tests; defaults to a cancellable setTimeout. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface PrivacyWatcher {
  /** Stop watching and abort any in-flight long-poll. Idempotent. */
  stop: () => void;
  /** Resolves once the loop exits (after stop or a fatal error). */
  done: Promise<void>;
}

/**
 * Maintain a single long-poll loop against the desktop privacy-events
 * endpoint. When the opaque generation advances, invoke `onPrivacyChanged`
 * so the caller can clear cached menus/recents and rebuild.
 *
 * The loop never busy-spins: on unreachable it backs off exponentially (with
 * doubling, capped), and it aborts cleanly via `stop()`.
 */
export function startPrivacyWatcher(options: PrivacyWatcherOptions): PrivacyWatcher {
  const fetchFn = options.fetchFn ?? (fetch as unknown as WatcherFetch);
  const baseBackoff = options.baseBackoffMs ?? 1_000;
  const maxBackoff = options.maxBackoffMs ?? 15_000;
  const delay = options.delay ?? defaultDelay;

  const controller = new AbortController();
  let stopped = false;
  let since = 0;
  let wasConnected = false;
  let backoff = baseBackoff;

  const done = (async () => {
    while (!stopped) {
      const outcome = await fetchPrivacyEvents(since, fetchFn, controller.signal);
      if (stopped) break;

      if (outcome.kind === 'ok') {
        if (!wasConnected) {
          wasConnected = true;
          if (since > 0 || outcome.generation > 0) options.onReconnected?.();
        }
        backoff = baseBackoff;
        if (outcome.generation !== since) {
          since = outcome.generation;
          options.onPrivacyChanged(since);
        }
        // An unchanged generation means the heartbeat fired with no change;
        // re-poll immediately (the server holds again).
        continue;
      }

      if (wasConnected) {
        wasConnected = false;
        options.onDisconnected?.();
      }

      const wait = outcome.kind === 'rejected' ? maxBackoff : backoff;
      try {
        await delay(wait, controller.signal);
      } catch {
        // Aborted during backoff.
      }
      if (stopped) break;
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  })();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
    done,
  };
}

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
