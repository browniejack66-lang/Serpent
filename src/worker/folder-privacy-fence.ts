/**
 * Asset-id extraction for the folder privacy fence in the Worker request
 * dispatcher (see `assertPrivacyFence` in `src/worker/index.ts`).
 *
 * WorkerCommand is a discriminated union over ~150 shapes. Rather than adding
 * a guard to every metadata / media / mutation / history / sync / export
 * handler, the dispatcher collects the exact `assetId` and `assetIds` fields
 * reflectively and denies the whole request when any named asset is inside a
 * currently locked privacy root.
 *
 * Only those two exact key names are collected. Tag ids, collection ids,
 * folder ids and revision ids are deliberately NOT treated as assets, so this
 * fence cannot accidentally block unrelated commands. Non-string values are
 * ignored, and the walk is depth-capped to keep malformed input bounded.
 */
export function collectPrivacyGuardedAssetIds(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'assetId' && typeof child === 'string') {
        out.add(child);
      } else if (key === 'assetIds' && Array.isArray(child)) {
        for (const id of child) if (typeof id === 'string') out.add(id);
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return [...out];
}
