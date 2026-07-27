import { describe, expect, it } from "vitest";
import { BATTERIES } from "../src/core/batteries";
import { repoFile } from "./repo-file";

const dockerfile = repoFile("box", "Dockerfile");

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
