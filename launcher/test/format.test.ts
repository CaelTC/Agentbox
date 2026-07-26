import { describe, expect, it } from "vitest";
import { size } from "../src/core/format";

describe("size", () => {
  // The bug this replaced: a GB-only formatter in the main process rendered
  // every sub-gigabyte total as "0 GB", so a refused Import told the Sandbox
  // User "this needs 0 GB, and only 0 GB is free."
  it("never renders a non-empty size as 0 GB", () => {
    for (const bytes of [1, 1024, 40 * 1024 ** 2, 900 * 1024 ** 2]) {
      expect(size(bytes), `${bytes} bytes`).not.toMatch(/^0 GB$/);
    }
  });

  it("steps down through GB, MB and KB", () => {
    expect(size(2 * 1024 ** 3)).toBe("2 GB");
    expect(size(40 * 1024 ** 2)).toBe("40 MB");
    expect(size(4 * 1024)).toBe("4 KB");
  });

  it("keeps one decimal for gigabytes, none below", () => {
    expect(size(1.55 * 1024 ** 3)).toBe("1.6 GB");
    expect(size(1.4 * 1024 ** 2)).toBe("1 MB");
  });

  it("switches unit exactly at each boundary", () => {
    expect(size(1024 ** 3)).toBe("1 GB");
    expect(size(1024 ** 3 - 1)).toBe("1024 MB");
    expect(size(1024 ** 2)).toBe("1 MB");
  });
});
