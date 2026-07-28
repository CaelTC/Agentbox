import { describe, expect, it } from "vitest";
import { boxRunArgs } from "../src/core/box";
import {
  BOX_IMAGE,
  DEFINITION_REPO,
  ENGINE_PROFILE,
  RESOURCE_CAP,
} from "../src/core/config";
import { TERMINAL_PORT } from "../src/core/preview";
import { colimaStartArgs, isColimaRunning } from "../src/main/colima";
import { repoFile } from "./repo-file";

/**
 * core/config.ts is the declared source of truth for the load-bearing constants,
 * but three scripts must carry their own copies: the Install Scripts run before
 * the Launcher exists, and the walking-skeleton script runs without it. None can
 * import TypeScript, so the values are duplicated by necessity — and the seam is
 * held here rather than by the "keep in sync" comments that used to sit in each
 * file. Drift means an installer that provisions a differently-named machine, a
 * different image tag, or a Box outside the Resource Cap (CONTEXT.md).
 */
const SKELETON = repoFile("scripts", "agentbox.sh");
const INSTALL_SH = repoFile("launcher", "install", "install.sh");
const INSTALL_PS1 = repoFile("launcher", "install", "install.ps1");

/** The `NAME="value"` / `NAME=42` assignments at the top of a bash script. */
function assignments(script: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [, name, quoted, bare] of script.matchAll(
    /^([A-Z_]+)=(?:"([^"$]*)"|([^\s"$]+))\s*$/gm,
  )) {
    vars[name] = quoted ?? bare;
  }
  return vars;
}

/**
 * A shell command's argv: line continuations joined, `$VAR` / `${VAR}` expanded
 * from the script's own assignments, quotes dropped. Not a shell parser — these
 * scripts are deliberately written as flat literal argument lists.
 */
function argv(command: string, vars: Record<string, string> = {}): string[] {
  return command
    .replace(/\\\n/g, " ")
    .replace(/\$\{?([A-Z_]+)\}?/g, (whole, name: string) => vars[name] ?? whole)
    .replace(/"/g, "")
    .trim()
    .split(/\s+/);
}

/** One command in a script, from its first word to `end`. */
function command(script: string, pattern: RegExp, what: string): string {
  const found = script.match(pattern);
  expect(found, `${what} is gone — this drift test cannot see it any more`).not.toBeNull();
  return found![0];
}

describe("scripts/agentbox.sh (the walking skeleton) against the core", () => {
  const vars = assignments(SKELETON);

  it("runs the Box with exactly boxRunArgs(): name, volumes, image, and every published port in order", () => {
    // One comparison covers BOX_CONTAINER, both volume names and their mount
    // points, BOX_IMAGE, and PREVIEW_PORTS + TERMINAL_PORT — values AND order.
    // These are the constants nothing else outside core/ carries.
    const run = command(SKELETON, /docker run -d[\s\S]*?sleep infinity/, "the `docker run` block");
    expect(argv(run, vars).slice(1)).toEqual(boxRunArgs());
  });

  it("starts the Engine with exactly colimaStartArgs(): the profile at the Resource Cap", () => {
    const start = command(SKELETON, /^\s*colima start .*$/m, "the `colima start` line");
    expect(argv(start, vars).slice(1)).toEqual(colimaStartArgs());
  });

  it("declares the Resource Cap the Launcher does", () => {
    expect({
      cpu: Number(vars.CPU),
      memoryGiB: Number(vars.MEMORY),
      diskGiB: Number(vars.DISK),
    }).toEqual(RESOURCE_CAP);
  });

  it("points the user at the web terminal on TERMINAL_PORT", () => {
    // The URL it PRINTS, bounded at both ends. `toContain("127.0.0.1:7681")` was
    // satisfied twice over by accident: `-p 127.0.0.1:7681:7681` (already covered
    // by boxRunArgs above) matched it, and being a prefix match it would have
    // gone on matching a message that sent the user to `:76810`.
    expect(SKELETON).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${TERMINAL_PORT}(?![\\d:])`));
  });

  it("greps colima status for a line a NAMED profile actually prints", () => {
    // The bug this pins: `grep -qi "colima is running"` never matches, because
    // with --profile the line reads `colima [profile=agentbox] is running`. The
    // script then rebuilt and re-ran on every launch. main/colima.ts's
    // isColimaRunning documents the same fix; both must agree on both lines.
    const grep = SKELETON.match(/colima status[^\n]*grep -qi "([^"]+)"/);
    expect(grep, "agentbox.sh no longer greps `colima status`").not.toBeNull();
    const pattern = grep![1].toLowerCase();
    const up = `time="..." level=info msg="colima [profile=${ENGINE_PROFILE}] is running"`;
    const down = `time="..." level=info msg="colima [profile=${ENGINE_PROFILE}] is not running"`;

    expect(up.toLowerCase()).toContain(pattern);
    expect(down.toLowerCase()).not.toContain(pattern);
    expect(isColimaRunning(up)).toBe(true);
    expect(isColimaRunning(down)).toBe(false);
  });
});

describe("install/install.sh (the Mac Install Script) against the core", () => {
  it("clones the definition repo core/config.ts names", () => {
    expect(INSTALL_SH).toContain(`DEFINITION_REPO="${DEFINITION_REPO}"`);
  });

  it("starts Colima with exactly colimaStartArgs(): the profile at the Resource Cap", () => {
    const start = command(INSTALL_SH, /^\s*colima start .*$/m, "the `colima start` line");
    expect(argv(start).slice(1)).toEqual(colimaStartArgs());
  });

  it("builds the image tag the Launcher then runs", () => {
    const build = command(INSTALL_SH, /docker build -t \S+/, "the `docker build` line");
    expect(argv(build)[3]).toBe(BOX_IMAGE);
  });
});

describe("install/install.ps1 (the Windows Install Script) against the core", () => {
  /** A `$Name = 'value'` (or bare number) assignment in the PowerShell script. */
  function psVar(name: string): string {
    const found = INSTALL_PS1.match(
      new RegExp(`^\\$${name}\\s*=\\s*'?([^'\\r\\n]+)'?\\s*$`, "m"),
    );
    expect(found, `install.ps1 no longer sets $${name}`).not.toBeNull();
    return found![1].trim();
  }

  it("clones the definition repo core/config.ts names", () => {
    expect(psVar("DefinitionRepo")).toBe(DEFINITION_REPO);
  });

  it("names the podman machine ENGINE_PROFILE and builds BOX_IMAGE", () => {
    expect(psVar("PodmanMachine")).toBe(ENGINE_PROFILE);
    expect(psVar("BoxImage")).toBe(BOX_IMAGE);
  });

  it("provisions the machine at the Resource Cap", () => {
    expect({
      cpu: Number(psVar("CapCpu")),
      memoryGiB: Number(psVar("CapMemoryGiB")),
      diskGiB: Number(psVar("CapDiskGiB")),
    }).toEqual(RESOURCE_CAP);
  });
});
