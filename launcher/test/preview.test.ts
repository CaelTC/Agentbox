import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_PORTS,
  TERMINAL_PORT,
  detectServedPort,
  loopbackPublishArgs,
  previewDoc,
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

describe("previewDoc", () => {
  const doc = previewDoc();

  it("names every published port, so the doc can't drift from PREVIEW_PORTS", () => {
    for (const port of PREVIEW_PORTS) {
      expect(doc).toContain(String(port));
    }
  });

  it("tells Claude to bind 0.0.0.0 and never to bind loopback inside the Box", () => {
    expect(doc).toContain("0.0.0.0");
    // names the literal Claude actually types, not just "localhost"
    expect(doc).toContain("127.0.0.1");
    expect(doc).not.toMatch(/(--bind|--host|-b)[ =]?127\.0\.0\.1/);
    expect(doc).not.toMatch(/bind(ing)? (to )?`?127\.0\.0\.1/i);
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

  it("never picks the always-on web terminal port as the served page", () => {
    expect(TERMINAL_PORT).toBe(7681);
    expect(detectServedPort([TERMINAL_PORT])).toBeUndefined();
    expect(detectServedPort([TERMINAL_PORT, 5173])).toBe(5173);
    expect(detectServedPort([TERMINAL_PORT, 9999])).toBe(9999);
  });

  it("only ever returns a port inside the published (forwardable) set or a live port", () => {
    // 5173 is well-known AND published; picking it means Preview will actually resolve.
    expect(PREVIEW_PORTS).toContain(detectServedPort([5173, 3000]));
  });
});

describe("the Preview contract's two copies", () => {
  // core/preview.ts's previewDoc() is the source of truth; box/entrypoint.sh
  // duplicates the text verbatim because a bash build context cannot import
  // it. previewDoc()'s docstring claims a test keeps the two from drifting —
  // this is that test. Without it, changing PREVIEW_PORTS updates the doc the
  // Launcher reasons about and silently leaves the Box shipping the old ports.
  it("box/entrypoint.sh writes exactly what previewDoc() returns", () => {
    const script = readFileSync(join(__dirname, "..", "..", "box", "entrypoint.sh"), "utf8");
    const heredoc = script.match(
      /cat > \/home\/sandbox\/\.claude\/CLAUDE\.md <<'EOF'\n([\s\S]*?)\nEOF\n/,
    );
    expect(heredoc, "entrypoint.sh no longer writes ~/.claude/CLAUDE.md").not.toBeNull();
    expect(heredoc![1]).toBe(previewDoc().trimEnd());
  });
});
