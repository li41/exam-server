import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const aad = Buffer.from("server-foundation/examinee-credential/v1", "utf8");

const deriveKey = (masterKey: Buffer, purpose: string): Buffer =>
  createHmac("sha256", masterKey)
    .update(`server-foundation/examinee-credential/${purpose}/v1`, "utf8")
    .digest();

export interface ExamineeCredentialProtector {
  protect(value: string): string;
  unprotect(value: string): string;
  digest(value: string): string;
}

export class AesGcmExamineeCredentialProtector implements ExamineeCredentialProtector {
  private readonly encryptionKey: Buffer;
  private readonly lookupKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error(
        "Examinee credential master key must be exactly 32 bytes.",
      );
    }
    this.encryptionKey = deriveKey(masterKey, "encryption");
    this.lookupKey = deriveKey(masterKey, "lookup");
  }

  protect(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(aad);
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
      throw new Error("Stored examinee credential has an unsupported format.");
    }
    const iv = Buffer.from(ivRaw, "base64url");
    const ciphertext = Buffer.from(ciphertextRaw, "base64url");
    const tag = Buffer.from(tagRaw, "base64url");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error("Stored examinee credential has an invalid envelope.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAAD(aad);
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

export const parseExamineeCredentialMasterKey = (raw: string): Buffer => {
  const normalized = raw.trim();
  if (!/^[0-9a-f]{64}$/iu.test(normalized)) {
    throw new Error(
      "Examinee credential key file must contain exactly 64 hexadecimal characters.",
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
