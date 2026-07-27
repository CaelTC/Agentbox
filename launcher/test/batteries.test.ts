import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BATTERIES } from "../src/core/batteries";

const dockerfile = readFileSync(
  join(__dirname, "..", "..", "box", "Dockerfile"),
  "utf8",
);

describe("BATTERIES manifest", () => {
  it("lists the runtimes the ticket requires", () => {
    const names = BATTERIES.map((b) => b.name).sort();
    expect(names).toEqual(
      ["git", "mattpocock-skills", "node", "python", "rust"].sort(),
    );
  });
});

describe("the Box Dockerfile actually provisions each battery", () => {
  it.each(BATTERIES)("installs $name", (battery) => {
    const found = battery.dockerfileMarkers.some((m) => dockerfile.includes(m));
    expect(
      found,
      `Dockerfile is missing an install step for ${battery.name} ` +
        `(looked for: ${battery.dockerfileMarkers.join(", ")})`,
    ).toBe(true);
  });
});
