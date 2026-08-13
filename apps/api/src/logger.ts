export type LogFields = Record<string, unknown>;

export type Logger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

export const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
};

const normalizeFields = (fields: LogFields): LogFields =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value instanceof Error ? serializeError(value) : value,
    ]),
  );

export const createJsonLogger = (
  now: () => Date = () => new Date(),
): Logger => {
  const write = (
    level: "info" | "warn" | "error",
    event: string,
    fields: LogFields = {},
  ): void => {
    const line = JSON.stringify({
      timestamp: now().toISOString(),
      level,
      event,
      ...normalizeFields(fields),
    });
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.info(line);
    }
  };

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
};

export const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
