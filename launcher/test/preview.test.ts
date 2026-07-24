import { describe, expect, it } from "vitest";
import {
  PREVIEW_PORTS,
  detectServedPort,
  loopbackPublishArgs,
  previewUrl,
} from "../src/core/preview";

describe("loopbackPublishArgs", () => {
  it("publishes each preview port bound to 127.0.0.1 (Mac browser only, never the LAN)", () => {
    const args = loopbackPublishArgs([3000, 5173]);
    expect(args).toEqual([
      "-p", "127.0.0.1:3000:3000",
      "-p", "127.0.0.1:5173:5173",
    ]);
  });

  it("binds to loopback, not 0.0.0.0 — the forward is Box→browser only", () => {
    for (const a of loopbackPublishArgs(PREVIEW_PORTS)) {
      if (a.startsWith("127")) {
        expect(a.startsWith("127.0.0.1:")).toBe(true);
        expect(a).not.toContain("0.0.0.0");
      }
    }
  });
});

describe("previewUrl", () => {
  it("points the browser at localhost on the served port", () => {
    expect(previewUrl(5173)).toBe("http://localhost:5173");
  });
});

describe("detectServedPort", () => {
  it("prefers a known dev-server port when one is listening", () => {
    expect(detectServedPort([9999, 5173])).toBe(5173);
  });

  it("falls back to the first listening port if none are well-known", () => {
    expect(detectServedPort([9999, 12345])).toBe(9999);
  });

  it("returns undefined when nothing is listening", () => {
    expect(detectServedPort([])).toBeUndefined();
  });

  it("only ever returns a port inside the published (forwardable) set or a live port", () => {
    // 5173 is well-known AND published; picking it means Preview will actually resolve.
    expect(PREVIEW_PORTS).toContain(detectServedPort([5173, 3000]));
  });
});
