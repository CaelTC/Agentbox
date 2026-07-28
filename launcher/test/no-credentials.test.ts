import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boxRunArgs } from "../src/core/box";
import { GIT_SCRATCH_VOLUME, WORKSPACE_VOLUME } from "../src/core/config";
import { pushRunArgs } from "../src/core/github";

/**
 * ADR 0002 / ticket 09: the Box definition and Launcher ship NO credentials —
 * not on the host, not in the Box. Threat B's credential half is closed by
 * construction. This test guards that invariant so a key can never sneak in.
 */
const REPO_ROOT = join(__dirname, "..", "..");

// Directories that hold shippable source. Deliberately excludes node_modules,
// .git, dist, and this test's own directory (which names the patterns).
const SCAN_DIRS = ["box", "scripts", "docs", join("launcher", "src"), join("launcher", "install")];

const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "OpenSSH private key", re: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  { name: "GitHub classic token", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "GitHub fine-grained PAT", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "GitHub OAuth token", re: /gho_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9-]{20,}/ },
];

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir may not exist yet; nothing to scan
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else if (e.isFile() && statSync(p).size < 1_000_000) {
      yield p;
    }
  }
}

describe("no credentials are checked into the repo (ADR 0002)", () => {
  it("finds no key- or token-shaped material in any shipped file", () => {
    const offenders: string[] = [];
    for (const rel of SCAN_DIRS) {
      for (const file of walk(join(REPO_ROOT, rel))) {
        const text = readFileSync(file, "utf8");
        for (const { name, re } of CREDENTIAL_PATTERNS) {
          if (re.test(text)) {
            offenders.push(`${file}: ${name}`);
          }
        }
      }
    }
    expect(offenders, `Credential-shaped material found:\n${offenders.join("\n")}`).toEqual([]);
  });

  // ADR 0006 amended this: ONE credential now exists, on the host, held by the
  // Launcher. What must still hold is that nothing hands it to the Box.
  it("the long-lived Box carries no token and cannot see the publish scratch volume", () => {
    const args = boxRunArgs().join(" ");
    expect(args).not.toContain("AGENTBOX_GIT_TOKEN");
    expect(args).not.toContain(GIT_SCRATCH_VOLUME);
  });

  it("the credentialed publish container never mounts the Workspace", () => {
    const args = pushRunArgs("alice", "my-site", "my-site", "main", "AGENTBOX_GIT_TOKEN").join(" ");
    expect(args).not.toContain(WORKSPACE_VOLUME);
  });

  it("the Install Script never configures a git credential or SSH key", () => {
    const install = join(REPO_ROOT, "launcher", "install", "install.sh");
    const text = readFileSync(install, "utf8");
    // The definition repo must be cloned over public HTTPS with no auth.
    expect(text).not.toMatch(/git@github\.com/); // SSH remote implies a key
    expect(text).not.toMatch(/credential\.helper/);
    expect(text).not.toMatch(/x-access-token|:@github|password/i);
    expect(text).toMatch(/https:\/\/github\.com/); // public HTTPS clone
  });
});
