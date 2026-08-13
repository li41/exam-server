import { describe, expect, it, vi } from "vitest";
import { gracefulShutdown } from "../src/graceful-shutdown.js";

describe("gracefulShutdown", () => {
  it("waits for HTTP requests and background work before closing resources", async () => {
    let closeCallback: ((error?: Error) => void) | undefined;
    const closeResources = vi.fn().mockResolvedValue(undefined);
    const stopBackgroundJobs = vi.fn().mockResolvedValue(undefined);
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        closeCallback = callback;
        return server;
      }),
      closeAllConnections: vi.fn(),
    };

    const shutdown = gracefulShutdown({
      server: server as never,
      stopBackgroundJobs,
      closeResources,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(stopBackgroundJobs).toHaveBeenCalledTimes(1);
    expect(closeResources).not.toHaveBeenCalled();

    closeCallback?.();
    await expect(shutdown).resolves.toEqual({ forcedHttpClose: false });
    expect(closeResources).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("forces remaining HTTP connections closed after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const closeResources = vi.fn().mockResolvedValue(undefined);
      const server = {
        close: vi.fn(() => server),
        closeAllConnections: vi.fn(),
      };

      const shutdown = gracefulShutdown({
        server: server as never,
        closeResources,
        timeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(shutdown).resolves.toEqual({ forcedHttpClose: true });
      expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(closeResources).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
