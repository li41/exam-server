import type { LocalFileStorage } from "./local-file-storage.js";

export type FileCleanupJobOptions = {
  intervalMs?: number;
  onCleaned?: (count: number) => void;
  onError?: (error: unknown) => void;
};

export type FileCleanupJob = {
  stop(): Promise<void>;
};

export const defaultFileCleanupIntervalMs = 15 * 60 * 1000;

export const startFileCleanupJob = (
  storage: Pick<LocalFileStorage, "cleanupExpired">,
  options: FileCleanupJobOptions = {},
): FileCleanupJob => {
  const intervalMs = options.intervalMs ?? defaultFileCleanupIntervalMs;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("File cleanup interval must be a positive integer.");
  }

  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A logging callback must not turn a handled cleanup failure into an
      // unhandled rejection.
    }
  };

  const run = (): void => {
    if (stopped || inFlight) return;
    const operation = storage
      .cleanupExpired()
      .then((count) => {
        if (count > 0) options.onCleaned?.(count);
      })
      .catch(reportError);
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = undefined;
    });
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
};
