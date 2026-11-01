import type { LaunchMode } from '@/types';
import { applyLaunchMode, DEFAULT_LAUNCH_MODE } from '@/lib/site/launch-mode';
import { KEYS, local } from '@/lib/core/storage';

interface Submission {
  mode: LaunchMode;
  requestId: number;
  sequence: number;
}

function isLaunchMode(value: unknown): value is LaunchMode {
  return value === 'sidepanel' || value === 'tab';
}

async function readStoredMode(fallback = DEFAULT_LAUNCH_MODE): Promise<LaunchMode> {
  const value = await local.get<unknown>(KEYS.launchMode, fallback);
  return isLaunchMode(value) ? value : fallback;
}

async function readAppliedMode(): Promise<LaunchMode | undefined> {
  if (!chrome.sidePanel?.getPanelBehavior) return undefined;
  const behavior = await chrome.sidePanel.getPanelBehavior();
  return behavior.openPanelOnActionClick ? 'sidepanel' : 'tab';
}

async function setStoredMode(mode: LaunchMode): Promise<void> {
  if ((await readStoredMode()) !== mode) {
    await local.set(KEYS.launchMode, mode);
  }
}

/**
 * First restore the requested mode. If one side cannot be restored, align the
 * other side with whichever value can still be read so storage and Chrome do
 * not remain contradictory.
 */
async function restoreConsistency(preferredMode: LaunchMode): Promise<void> {
  const errors: unknown[] = [];

  try {
    await applyLaunchMode(preferredMode);
    try {
      await setStoredMode(preferredMode);
      return;
    } catch (error) {
      errors.push(error);
    }
  } catch (error) {
    errors.push(error);
  }

  try {
    const storedMode = await readStoredMode();
    await applyLaunchMode(storedMode);
    return;
  } catch (error) {
    errors.push(error);
  }

  try {
    const appliedMode = await readAppliedMode();
    if (appliedMode) {
      await setStoredMode(appliedMode);
      return;
    }
  } catch (error) {
    errors.push(error);
  }

  throw new Error(
    `无法恢复启动模式一致性：${errors.map((error) => error instanceof Error ? error.message : String(error)).join('；')}`,
  );
}

export function createLaunchModeController() {
  let sequence = 0;
  let userGeneration = 0;
  let pendingSubmissions = 0;
  let latestSubmission: Submission | undefined;
  let queue: Promise<void> = Promise.resolve();

  function serialize(work: () => Promise<void>): Promise<void> {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  }

  function isLatest(submission: Submission): boolean {
    return latestSubmission?.requestId === submission.requestId
      && latestSubmission.sequence === submission.sequence;
  }

  async function commit(submission: Submission): Promise<void> {
    const previousMode = await readStoredMode();
    if (!isLatest(submission)) return;

    try {
      await applyLaunchMode(submission.mode);

      if (!isLatest(submission)) {
        await restoreConsistency(previousMode);
        return;
      }

      await local.set(KEYS.launchMode, submission.mode);
    } catch (error) {
      try {
        await restoreConsistency(previousMode);
      } catch (recoveryError) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        throw new Error(`${originalMessage}；恢复失败：${recoveryMessage}`);
      }
      throw error;
    }
  }

  return {
    submit(mode: LaunchMode, requestId: number): Promise<void> {
      // requestId is scoped to one UI context, so arrival sequence decides
      // ordering when Options and Side Panel submit concurrently.
      const submission: Submission = { mode, requestId, sequence: ++sequence };
      latestSubmission = submission;
      userGeneration += 1;
      pendingSubmissions += 1;

      return serialize(async () => {
        try {
          if (isLatest(submission)) await commit(submission);
        } finally {
          pendingSubmissions -= 1;
          if (pendingSubmissions === 0 && latestSubmission === submission) {
            latestSubmission = undefined;
          }
        }
      });
    },

    sync(mode: LaunchMode): Promise<void> {
      const generation = userGeneration;

      return serialize(async () => {
        if (pendingSubmissions > 0 || generation !== userGeneration) return;

        // The caller may have read storage before a user submission committed.
        // Re-read it inside the queue so a stale startup sync cannot win later.
        const storedMode = await readStoredMode(mode);
        if (pendingSubmissions > 0 || generation !== userGeneration) return;

        try {
          await applyLaunchMode(storedMode);
        } catch (error) {
          try {
            await restoreConsistency(storedMode);
          } catch (recoveryError) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            throw new Error(`${originalMessage}；恢复失败：${recoveryMessage}`);
          }
          throw error;
        }
      });
    },
  };
}
