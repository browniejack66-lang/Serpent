import type { WorkerCommand } from '../shared/protocol/requests';
import type { WorkerResult } from '../shared/protocol/responses';

type PrivacyCommand = Extract<WorkerCommand, { type: 'folder.privacy' }>;

interface PrivacyTransitionDependencies {
  request(command: PrivacyCommand): Promise<WorkerResult>;
  beginFence(libraryId: string): void;
  endFence(libraryId: string): void;
  invalidate(libraryId: string): void;
  publish(libraryId: string): void;
}

/** Revoke reads before changing access, including requests already awaiting Worker. */
export function createFolderPrivacyTransition(deps: PrivacyTransitionDependencies) {
  const pending = new Map<string, Promise<void>>();
  return async (command: PrivacyCommand): Promise<WorkerResult> => {
    if (command.action === 'status') return deps.request(command);
    const previous = pending.get(command.libraryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    pending.set(command.libraryId, current);
    await previous;
    try {
      deps.beginFence(command.libraryId);
      try {
        deps.invalidate(command.libraryId);
        const result = await deps.request(command);
        deps.invalidate(command.libraryId);
        if (result.ok && result.type === 'folder.privacy') deps.publish(command.libraryId);
        return result;
      } finally {
        deps.endFence(command.libraryId);
      }
    } finally {
      release();
      if (pending.get(command.libraryId) === current) pending.delete(command.libraryId);
    }
  };
}
