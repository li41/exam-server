import { describe, expect, it } from "vitest";
import {
  AesGcmExamineeCredentialProtector,
  parseExamineeCredentialMasterKey,
} from "../src/examinee-credential-protector.js";

describe("AesGcmExamineeCredentialProtector", () => {
  it("round-trips readable credentials while randomizing ciphertext", () => {
    const protector = new AesGcmExamineeCredentialProtector(
      Buffer.alloc(32, 0x42),
    );
    const first = protector.protect("human-readable-password");
    const second = protector.protect("human-readable-password");

    expect(first).not.toBe(second);
    expect(first).not.toContain("human-readable-password");
    expect(protector.unprotect(first)).toBe("human-readable-password");
    expect(protector.unprotect(second)).toBe("human-readable-password");
    expect(protector.digest("human-readable-password")).toBe(
      protector.digest("human-readable-password"),
    );
    expect(protector.digest("human-readable-password")).not.toBe(
      protector.digest("different"),
    );
  });

  it("rejects modified authenticated ciphertext", () => {
    const protector = new AesGcmExamineeCredentialProtector(
      Buffer.alloc(32, 0x24),
    );
    const protectedValue = protector.protect("secret");
    const parts = protectedValue.split(".");
    parts[2] = `${parts[2]?.slice(0, -1)}${parts[2]?.endsWith("A") ? "B" : "A"}`;
    expect(() => protector.unprotect(parts.join("."))).toThrow();
  });

  it("requires a 32-byte hexadecimal master key file", () => {
    expect(parseExamineeCredentialMasterKey("ab".repeat(32))).toEqual(
      Buffer.from("ab".repeat(32), "hex"),
    );
    expect(() => parseExamineeCredentialMasterKey("short")).toThrow(
      /64 hexadecimal/,
    );
    expect(() =>
      parseExamineeCredentialMasterKey(`${"ab".repeat(31)}zz`),
    ).toThrow(/64 hexadecimal/);
  });
});
