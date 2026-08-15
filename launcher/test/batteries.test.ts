import { describe, expect, it } from "vitest";
import { BATTERIES } from "../src/core/batteries";
import { repoDir, repoFile } from "./repo-file";

const dockerfile = repoFile("box", "Dockerfile");

describe("BATTERIES manifest", () => {
  it("lists the runtimes the ticket requires", () => {
    const names = BATTERIES.map((b) => b.name).sort();
    expect(names).toEqual(
      ["codex", "codex-skills", "git", "mattpocock-skills", "node", "python", "rust"].sort(),
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

describe("the Codex skills battery", () => {
  // Enumerated, not listed: a skill added tomorrow is covered without an edit
  // here. Only directories are skills — README.md sits alongside them.
  const skills = repoDir("box", "codex-skills").filter((n) => !n.endsWith(".md"));

  it("ships at least the disciplines the Claude-side plugin ships", () => {
    expect(skills).toContain("tdd");
    expect(skills).toContain("diagnosing-bugs");
    expect(skills).toContain("code-review");
  });

  // Codex refuses a skill whose SKILL.md has no frontmatter, and DISPLAYS a
  // skill by the `name` in it — so a directory renamed without its frontmatter
  // would still load, under the old name, invoked by a `$` mention that no
  // longer matches the directory anyone reads.
  it.each(skills)("%s is a SKILL.md with the frontmatter Codex requires", (skill) => {
    const skillMd = repoFile("box", "codex-skills", skill, "SKILL.md");
    expect(skillMd, `box/codex-skills/${skill}/SKILL.md has no name/description frontmatter`)
      .toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: \\S.*\\n---\\n`));
  });

  // The image bakes them into /opt because /home/sandbox is a named volume; the
  // entrypoint is what actually puts them where Codex looks.
  it("entrypoint.sh lays them into the directory Codex reads user skills from", () => {
    const script = repoFile("box", "entrypoint.sh");
    expect(script).toContain("/opt/codex-skills");
    expect(script).toContain("/home/sandbox/.agents/skills");
  });
});
