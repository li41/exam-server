import { describe, expect, it } from "vitest";
import {
  AesGcmAffairReceiptProtector,
  AesGcmExamineeCredentialProtector,
} from "../src/examinee-credential-protector.js";

describe("affair receipt sensitive-field protector", () => {
  it("uses deterministic lookup digests without making encryption deterministic", () => {
    const protector = new AesGcmAffairReceiptProtector(Buffer.alloc(32, 0x62));
    const first = protector.protect("A123456789");
    const second = protector.protect("A123456789");

    expect(first).not.toBe(second);
    expect(protector.unprotect(first)).toBe("A123456789");
    expect(protector.digest("A123456789")).toBe(
      protector.digest("A123456789"),
    );
    expect(protector.digest("A123456789")).not.toBe(
      protector.digest("B120863514"),
    );
  });

  it("domain-separates receipt lookup keys from examinee lookup keys", () => {
    const masterKey = Buffer.alloc(32, 0x41);
    const receipt = new AesGcmAffairReceiptProtector(masterKey);
    const examinee = new AesGcmExamineeCredentialProtector(masterKey);

    expect(receipt.digest("same-value")).not.toBe(examinee.digest("same-value"));
    expect(receipt.protect("same-value")).not.toContain("same-value");
  });
});
