// host/test/fork-reference-unsupported.test.ts
import { describe, it, expect } from "vitest";
import { ForkReferenceUnsupportedError } from "../src/fork-reference-unsupported";

describe("ForkReferenceUnsupportedError", () => {
  it("names the unsupported kind and carries EOPNOTSUPP", () => {
    const err = new ForkReferenceUnsupportedError("externref");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ForkReferenceUnsupportedError");
    expect(err.kind).toBe("externref");
    expect(err.errno).toBe(95);
    expect(err.message).toContain("externref");
    expect(err.message).toContain("fork-reference-support");
  });
});
