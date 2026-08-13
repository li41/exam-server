import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonLogger } from "../src/logger.js";

describe("JSON logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one parseable JSON record per event", () => {
    const output = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const logger = createJsonLogger(() => new Date("2026-08-10T09:00:00.000Z"));

    logger.info("server_started", { port: 8787 });

    expect(output).toHaveBeenCalledTimes(1);
    const line = String(output.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-08-10T09:00:00.000Z",
      level: "info",
      event: "server_started",
      port: 8787,
    });
  });
});
