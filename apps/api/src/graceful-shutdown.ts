export type ShutdownServer = {
  close(callback?: (error?: Error) => void): unknown;
  closeAllConnections?: () => void;
};

export type GracefulShutdownOptions = {
  server: ShutdownServer;
  stopBackgroundJobs?: () => Promise<void>;
  closeResources: () => Promise<void>;
  timeoutMs?: number;
};

export type GracefulShutdownResult = {
  forcedHttpClose: boolean;
};

export const defaultShutdownTimeoutMs = 30_000;

const closeHttpServer = (
  server: ShutdownServer,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, forced = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(forced);
    };

    const timer = setTimeout(() => {
      try {
        if (!server.closeAllConnections) {
          finish(
            new Error(
              "HTTP server did not close before the timeout and does not support forced connection closing.",
            ),
          );
          return;
        }
        server.closeAllConnections();
        finish(undefined, true);
      } catch (error) {
        finish(error);
      }
    }, timeoutMs);
    timer.unref?.();

    try {
      server.close((error?: Error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });

export const gracefulShutdown = async (
  options: GracefulShutdownOptions,
): Promise<GracefulShutdownResult> => {
  const timeoutMs = options.timeoutMs ?? defaultShutdownTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Shutdown timeout must be a positive safe integer.");
  }

  const errors: unknown[] = [];
  let forcedHttpClose = false;

  const httpClose = closeHttpServer(options.server, timeoutMs)
    .then((forced) => {
      forcedHttpClose = forced;
    })
    .catch((error: unknown) => {
      errors.push(error);
    });
  const backgroundStop = (
    options.stopBackgroundJobs?.() ?? Promise.resolve()
  ).catch((error: unknown) => {
    errors.push(error);
  });

  await Promise.all([httpClose, backgroundStop]);

  try {
    await options.closeResources();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Graceful shutdown encountered errors.");
  }

  return { forcedHttpClose };
};
