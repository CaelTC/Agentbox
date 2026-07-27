import { describe, expect, it } from "vitest";
import {
  commitTrusted,
  hashDefinition,
  refreshDecision,
  shouldRebuild,
  updateMessage,
  buildMessage,
} from "../src/core/refresh";

const defA = [
  { path: "Dockerfile", content: "FROM node:22" },
  { path: "entrypoint.sh", content: "echo hi" },
];
const defB = [
  { path: "Dockerfile", content: "FROM node:22-bookworm" }, // changed
  { path: "entrypoint.sh", content: "echo hi" },
];

describe("hashDefinition", () => {
  it("is deterministic regardless of file ordering", () => {
    const reordered = [defA[1]!, defA[0]!];
    expect(hashDefinition(defA)).toBe(hashDefinition(reordered));
  });

  it("changes when any file's content changes", () => {
    expect(hashDefinition(defA)).not.toBe(hashDefinition(defB));
  });

  it("changes when a file is added or removed", () => {
    expect(hashDefinition(defA)).not.toBe(
      hashDefinition([...defA, { path: "new.txt", content: "x" }]),
    );
  });
});

describe("commitTrusted (supply-chain gate, ADR 0002)", () => {
  it("trusts any pull when no commit is pinned", () => {
    expect(commitTrusted(undefined, "deadbeef")).toBe(true);
    expect(commitTrusted(undefined, undefined)).toBe(true);
  });

  it("trusts only an exact match when a commit is pinned", () => {
    expect(commitTrusted("abc123", "abc123")).toBe(true);
  });

  it("refuses a HEAD that differs from the pin (compromised/unexpected upstream)", () => {
    expect(commitTrusted("abc123", "def456")).toBe(false);
    expect(commitTrusted("abc123", undefined)).toBe(false);
  });
});

describe("shouldRebuild", () => {
  it("rebuilds on first ever launch (no previous image)", () => {
    expect(shouldRebuild(undefined, "abc")).toBe(true);
  });

  it("rebuilds when the definition changed", () => {
    expect(shouldRebuild("abc", "def")).toBe(true);
  });

  it("does NOT rebuild when the definition is unchanged (fast start — ticket 09 AC)", () => {
    expect(shouldRebuild("abc", "abc")).toBe(false);
  });
});

describe("refreshDecision", () => {
  it("online + changed => pull already happened, now rebuild", () => {
    expect(
      refreshDecision({ previousHash: "old", currentHash: "new", online: true }),
    ).toMatchObject({ action: "rebuild" });
  });

  it("online + unchanged => start quickly without rebuilding", () => {
    expect(
      refreshDecision({ previousHash: "same", currentHash: "same", online: true }),
    ).toMatchObject({ action: "start" });
  });

  it("offline => keep running the last-built image, never fail", () => {
    const d = refreshDecision({ previousHash: "old", currentHash: undefined, online: false });
    expect(d.action).toBe("start");
    expect(d.reason).toMatch(/offline/i);
  });

  it("offline with no prior image => must build once before it can run", () => {
    const d = refreshDecision({ previousHash: undefined, currentHash: undefined, online: false });
    expect(d.action).toBe("error");
  });
});

/**
 * What "Update Claudebox" says afterwards. The failure that matters here is
 * silent-success: an offline check, or an integrity refusal, must never come
 * back reading as "you're up to date".
 */
describe("updateMessage", () => {
  it("confirms a real update, and says the sandbox restarted", () => {
    const m = updateMessage({ action: "rebuilt", reason: "changed upstream", online: true });
    expect(m).toMatch(/up to date/i);
    expect(m).toMatch(/restarted/i);
  });

  // An unpinned build means the integrity gate ran with nothing to check
  // against (threat B) — that must reach the user, not just a console.
  it("warns to the user's face when the build ran unpinned", () => {
    const m = updateMessage({ action: "rebuilt", reason: "changed", online: true, unpinned: true });
    expect(m).toMatch(/UNPINNED/);
    expect(
      updateMessage({ action: "rebuilt", reason: "changed", online: true, unpinned: false }),
    ).not.toMatch(/UNPINNED/);
  });

  it("says nothing was new when the definition is unchanged", () => {
    expect(updateMessage({ action: "started", reason: "unchanged", online: true })).toMatch(
      /already up to date/i,
    );
  });

  it("does NOT claim up-to-date when the pull never happened", () => {
    const m = updateMessage({ action: "started", reason: "Offline;", online: false });
    expect(m).not.toMatch(/already up to date/i);
    expect(m).toMatch(/couldn't fetch/i);
  });

  it("passes an integrity refusal through verbatim, so the reason is visible", () => {
    const reason = "Refusing to build: the Box definition's origin is 'evil.example', not…";
    expect(updateMessage({ action: "blocked", reason, online: true })).toBe(reason);
  });

  it("reports a failure as a failure", () => {
    expect(updateMessage({ action: "error", reason: "Box rebuild failed: boom", online: true })).toMatch(
      /^Couldn't update Claudebox: /,
    );
  });
});

/**
 * A first build compiles the whole Box and takes minutes; a rebuild off warm
 * layers usually does not. `refreshDecision` already knows which it is, so the
 * screen can say so instead of leaving someone to guess from a stalled line.
 */
describe("buildMessage", () => {
  it("warns that the first build is a long one", () => {
    expect(buildMessage(true)).toMatch(/few minutes/i);
  });

  it("does not repeat that warning on later rebuilds", () => {
    expect(buildMessage(false)).not.toMatch(/few minutes/i);
  });

  it("says it is building, either way", () => {
    expect(buildMessage(true)).toMatch(/building/i);
    expect(buildMessage(false)).toMatch(/building/i);
  });
});
