import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface SensitiveFieldProtector {
  protect(value: string): string;
  unprotect(value: string): string;
  digest(value: string): string;
}

const deriveKey = (masterKey: Buffer, scope: string, purpose: string): Buffer =>
  createHmac("sha256", masterKey)
    .update(`server-foundation/${scope}/${purpose}/v1`, "utf8")
    .digest();

/**
 * Shared AES-256-GCM facility for sensitive fields.
 *
 * A single master key lifecycle is reused, while each data domain and each purpose
 * (encryption vs lookup/blind-index) gets a separately derived HMAC key.
 */
export class AesGcmScopedProtector implements SensitiveFieldProtector {
  private readonly encryptionKey: Buffer;
  private readonly lookupKey: Buffer;
  private readonly aad: Buffer;

  constructor(masterKey: Buffer, private readonly scope: string) {
    if (masterKey.length !== 32) {
      throw new Error("Sensitive-data master key must be exactly 32 bytes.");
    }
    if (!/^[a-z0-9-]+$/u.test(scope)) {
      throw new Error("Sensitive-data protector scope is invalid.");
    }
    this.encryptionKey = deriveKey(masterKey, scope, "encryption");
    this.lookupKey = deriveKey(masterKey, scope, "lookup");
    this.aad = Buffer.from(`server-foundation/${scope}/v1`, "utf8");
  }

  protect(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(this.aad);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      "v1",
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      tag.toString("base64url"),
    ].join(".");
  }

  unprotect(value: string): string {
    const [version, ivRaw, ciphertextRaw, tagRaw, extra] = value.split(".");
    if (version !== "v1" || !ivRaw || !ciphertextRaw || !tagRaw || extra) {
      throw new Error(`Stored ${this.scope} value has an unsupported format.`);
    }
    const iv = Buffer.from(ivRaw, "base64url");
    const ciphertext = Buffer.from(ciphertextRaw, "base64url");
    const tag = Buffer.from(tagRaw, "base64url");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error(`Stored ${this.scope} value has an invalid envelope.`);
    }
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAAD(this.aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }

  digest(value: string): string {
    return createHmac("sha256", this.lookupKey)
      .update(value, "utf8")
      .digest("hex");
  }
}

export interface ExamineeCredentialProtector extends SensitiveFieldProtector {}

export class AesGcmExamineeCredentialProtector
  extends AesGcmScopedProtector
  implements ExamineeCredentialProtector
{
  constructor(masterKey: Buffer) {
    super(masterKey, "examinee-credential");
  }
}

export class AesGcmAffairReceiptProtector extends AesGcmScopedProtector {
  constructor(masterKey: Buffer) {
    super(masterKey, "affair-receipt");
  }
}

export const parseExamineeCredentialMasterKey = (raw: string): Buffer => {
  const normalized = raw.trim();
  if (!/^[0-9a-f]{64}$/iu.test(normalized)) {
    throw new Error(
      "Sensitive-data key file must contain exactly 64 hexadecimal characters.",
    );
  }
  return Buffer.from(normalized, "hex");
};

export const secureDigestEquals = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.length > 0 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};
