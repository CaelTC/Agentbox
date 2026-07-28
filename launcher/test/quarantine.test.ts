import { describe, expect, it } from "vitest";
import { quarantineValue, untrustedMark } from "../src/core/export";
import { markExportedUntrusted } from "../src/main/workspace";

/**
 * Export's untrusted mark (#12). `chmod 0o644` is threat C's second layer on
 * macOS only — on Windows it just toggles the read-only bit, so without a native
 * mark the defence silently degrades to the extension allowlist alone. Both
 * branches are asserted from a Mac by injecting the platform, exactly as
 * `spawnPath(path, exists)` injects its filesystem probe.
 */

const TARGET = "/Users/sandbox/Agentbox/My Project/report.docx";
// 2026-07-25T00:00:00Z — fixed so the quarantine timestamp is assertable.
const NOW = 1_784_937_600_000;

describe("untrustedMark", () => {
  it("writes the internet-zone stream on Windows, so Office opens the file in Protected View", () => {
    const mark = untrustedMark(TARGET, "win32", NOW);
    expect(mark).toEqual({
      kind: "stream",
      path: `${TARGET}:Zone.Identifier`,
      content: "[ZoneTransfer]\r\nZoneId=3\r\n",
    });
  });

  it("keeps the stream a suffix on the file's own path, never a child of it", () => {
    const mark = untrustedMark("C:\\Users\\sandbox\\notes.txt", "win32", NOW);
    expect(mark).toMatchObject({ path: "C:\\Users\\sandbox\\notes.txt:Zone.Identifier" });
  });

  it("sets com.apple.quarantine on macOS, so Gatekeeper gets its say", () => {
    expect(untrustedMark(TARGET, "darwin", NOW)).toEqual({
      kind: "command",
      command: "xattr",
      args: ["-w", "com.apple.quarantine", "0001;6a63fc80;Agentbox;", TARGET],
    });
  });

  it("carries the download flag alone — no user-approved or assessment-ok bit", () => {
    expect(quarantineValue(NOW).split(";")[0]).toBe("0001");
  });

  it("has no mark for a host it does not ship on, rather than a wrong one", () => {
    expect(untrustedMark(TARGET, "linux", NOW)).toBeUndefined();
  });
});

describe("markExportedUntrusted", () => {
  const never = () => {
    throw new Error("must not be called on this platform");
  };
  const ok = async () => ({ code: 0 });

  it("writes the Zone.Identifier stream on Windows and reports success", async () => {
    const written: Array<[string, string]> = [];
    const marked = await markExportedUntrusted(
      TARGET,
      "win32",
      (path, data) => void written.push([path, data]),
      never,
    );
    expect(marked).toBe(true);
    expect(written).toEqual([[`${TARGET}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n"]]);
  });

  it("spawns xattr on macOS and reports success", async () => {
    const calls: Array<readonly string[]> = [];
    const marked = await markExportedUntrusted(TARGET, "darwin", never, async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0 };
    });
    expect(marked).toBe(true);
    expect(calls[0]?.slice(0, 3)).toEqual(["xattr", "-w", "com.apple.quarantine"]);
  });

  // The export has already landed by the time the mark runs. Reporting false
  // keeps the files (ADR 0003 refused host-side deletion) while `boxExport`
  // counts them into ExportResult.unmarked, so a failure is never a silent pass.
  it("reports failure, without throwing, when the stream write fails", async () => {
    const marked = await markExportedUntrusted(
      TARGET,
      "win32",
      () => {
        throw new Error("EACCES");
      },
      never,
    );
    expect(marked).toBe(false);
  });

  it("reports failure when xattr exits non-zero", async () => {
    expect(await markExportedUntrusted(TARGET, "darwin", never, async () => ({ code: 1 }))).toBe(
      false,
    );
  });

  it("reports failure when the xattr spawn itself rejects", async () => {
    const marked = await markExportedUntrusted(TARGET, "darwin", never, async () => {
      throw new Error("spawn xattr ENOENT");
    });
    expect(marked).toBe(false);
  });

  it("counts an unknown host as unmarked instead of quietly succeeding", async () => {
    expect(await markExportedUntrusted(TARGET, "linux", never, ok)).toBe(false);
  });
});
