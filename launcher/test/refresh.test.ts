import { describe, expect, it } from "vitest";
import { hashDefinition, refreshDecision, shouldRebuild } from "../src/core/refresh";

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
