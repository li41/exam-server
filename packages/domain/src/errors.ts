export type DomainErrorCode =
  | "validation_error"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "payload_too_large"
  | "checksum_mismatch"
  | "upload_expired"
  | "capability_missing"
  | "invalid_cursor";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super("not_found", `${resource} ${id} was not found.`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super("conflict", message);
    this.name = "ConflictError";
  }
}

export class InvalidCursorError extends DomainError {
  constructor() {
    super("invalid_cursor", "The supplied cursor is invalid.");
    this.name = "InvalidCursorError";
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Authentication is required.") {
    super("unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "You do not have permission to perform this action.") {
    super("forbidden", message);
    this.name = "ForbiddenError";
  }
}

export class CapabilityMissingError extends DomainError {
  constructor(capability: string) {
    super("capability_missing", `${capability} is not configured.`);
    this.name = "CapabilityMissingError";
  }
}

export class RateLimitedError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("rate_limited", "Too many attempts. Try again later.");
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class PayloadTooLargeError extends DomainError {
  constructor() {
    super("payload_too_large", "The upload is larger than the allowed limit.");
    this.name = "PayloadTooLargeError";
  }
}

export class ChecksumMismatchError extends DomainError {
  constructor() {
    super("checksum_mismatch", "The uploaded content checksum does not match.");
    this.name = "ChecksumMismatchError";
  }
}

export class UploadExpiredError extends DomainError {
  constructor() {
    super("upload_expired", "The upload session has expired.");
    this.name = "UploadExpiredError";
  }
}
