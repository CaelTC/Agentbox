import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_SCRATCH_DIR, GIT_SCRATCH_VOLUME, WORKSPACE_VOLUME } from "../src/core/config";
import {
  BRANCH_MARKER,
  ORIGIN_MARKER,
  assertNoWorkspaceMount,
  assertValidBranch,
  bundleRunArgs,
  bundleScript,
  classifyPoll,
  parseBranch,
  parseDeviceCode,
  parseGithubRemote,
  parseOrigin,
  pushRunArgs,
  pushScript,
  repoNameFor,
} from "../src/core/github";

/** ADR 0006: the GitHub token never meets the Workspace, and never meets Claude. */
describe("the device flow", () => {
  it("reads a device code, defaulting only the timings", () => {
    const code = parseDeviceCode({ device_code: "secret", user_code: "ABCD-1234" });
    expect(code).toMatchObject({
      deviceCode: "secret",
      userCode: "ABCD-1234",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
  });

  it("names the one error a maintainer can actually fix", () => {
    expect(() => parseDeviceCode({ error: "device_flow_disabled" })).toThrow(/Device Flow/);
  });

  it("keeps waiting while the user is still typing the code", () => {
    expect(classifyPoll({ error: "authorization_pending" }, 5)).toEqual({
      kind: "wait",
      intervalSeconds: 5,
    });
  });

  it("backs off on slow_down — GitHub's interval, or +5s when it sends none", () => {
    expect(classifyPoll({ error: "slow_down", interval: 10 }, 5)).toEqual({
      kind: "wait",
      intervalSeconds: 10,
    });
    expect(classifyPoll({ error: "slow_down" }, 5)).toEqual({ kind: "wait", intervalSeconds: 10 });
  });

  it("stops on expiry, refusal, and anything it does not recognise", () => {
    // The last one matters most: treating unknown errors as "wait" spins for the
    // full 15 minutes on a code that can never work.
    expect(classifyPoll({ error: "expired_token" }, 5).kind).toBe("failed");
    expect(classifyPoll({ error: "access_denied" }, 5).kind).toBe("failed");
    expect(classifyPoll({ error: "incorrect_client_credentials" }, 5).kind).toBe("failed");
  });

  it("takes the token when it arrives", () => {
    expect(classifyPoll({ access_token: "t" }, 5)).toEqual({ kind: "token", token: "t" });
  });
});

describe("the two publish containers", () => {
  it("owns the scratch directory in the image, so the volume is writable", () => {
    // A named volume inherits the image directory's ownership when it is first
    // created. Without this the volume is root-owned and the unprivileged
    // `sandbox` user cannot write the bundle — which is a runtime EACCES no unit
    // test would otherwise see.
    const dockerfile = readFileSync(join(__dirname, "..", "..", "box", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(
      new RegExp(`chown[^\\n]*sandbox:sandbox[^\\n]*${GIT_SCRATCH_DIR}`),
    );
  });

  it("packages the Project in a container with no token", () => {
    const args = bundleRunArgs("my-site");
    expect(args.join(" ")).toContain(`${WORKSPACE_VOLUME}:/workspace`);
    expect(args.join(" ")).toContain(`${GIT_SCRATCH_VOLUME}:/scratch`);
    expect(args).not.toContain("-e");
  });

  it("pushes from a container that never mounts the Workspace", () => {
    const args = pushRunArgs("alice", "my-site", "my-site", "main", "CLAUDEBOX_GIT_TOKEN");
    expect(args.join(" ")).not.toContain(WORKSPACE_VOLUME);
    expect(args.join(" ")).toContain(`${GIT_SCRATCH_VOLUME}:/scratch`);
  });

  it("passes the token by name only, so it is not in the host's process list", () => {
    const args = pushRunArgs("alice", "my-site", "my-site", "main", "CLAUDEBOX_GIT_TOKEN");
    expect(args[args.indexOf("-e") + 1]).toBe("CLAUDEBOX_GIT_TOKEN");
    // A value alongside the name would be the leak this whole design avoids.
    expect(args.join(" ")).not.toMatch(/CLAUDEBOX_GIT_TOKEN=/);
  });

  it("refuses outright to mix the token with the Workspace", () => {
    expect(() =>
      assertNoWorkspaceMount(["run", "-v", `${WORKSPACE_VOLUME}:/workspace`, "img"]),
    ).toThrow(/Refusing/);
    expect(() =>
      assertNoWorkspaceMount(["run", "--volume", `${WORKSPACE_VOLUME}:/ws:ro`, "img"]),
    ).toThrow(/Refusing/);
    expect(() => assertNoWorkspaceMount(["run", "-v", `${GIT_SCRATCH_VOLUME}:/scratch`])).not.toThrow();
  });

  it("keeps the egress policy over both containers", () => {
    for (const args of [bundleRunArgs("s"), pushRunArgs("a", "s", "s", "main", "T")]) {
      expect(args).toContain("--cap-add");
      expect(args).toContain("NET_ADMIN");
    }
  });

  it("names the repo after the slug, never a name Claude can write", () => {
    expect(repoNameFor("my-site")).toBe("my-site");
    expect(() => repoNameFor("../etc")).toThrow(/Unsafe/);
    expect(() => bundleRunArgs("a; rm -rf /")).toThrow(/Unsafe/);
  });

  it("survives a Project with nothing new to commit, and reports an empty one", () => {
    const script = bundleScript("my-site");
    expect(script).toContain("|| true"); // a no-op commit exits 1
    expect(script).toContain("exit 3"); // nothing to save yet
  });

  it("commits in the Project's own repo and bundles the branch that is checked out", () => {
    const script = bundleScript("my-site");
    // Ordinary git: on main you push main, on feature/x you push feature/x. The
    // branch is read back rather than assumed, and a detached HEAD says so.
    expect(script).toContain('cd "/workspace/my-site"');
    expect(script).toContain("git symbolic-ref -q --short HEAD");
    expect(script).toContain("exit 4"); // detached HEAD
    expect(script).toContain('git bundle create -q "/scratch/my-site.bundle" "refs/heads/$branch"');
    expect(script).toContain(BRANCH_MARKER);
  });

  it("reads the branch back from a marked line, not from whatever printed last", () => {
    // The Box image's entrypoint writes to stdout too, so "the last line" is not
    // a contract.
    expect(parseBranch(`starting the box\n${BRANCH_MARKER} feature/x\n`)).toBe("feature/x");
    expect(parseBranch("no marker here")).toBeUndefined();
  });

  it("refuses a branch name that could break out of the credentialed script", () => {
    // Chosen inside the Box, embedded in the one script that holds the token.
    expect(assertValidBranch("feature/new-thing")).toBe("feature/new-thing");
    expect(() => assertValidBranch("main; curl evil.example")).toThrow(/can't save/);
    expect(() => assertValidBranch("../../etc")).toThrow(/can't save/);
    expect(() => pushScript("alice", "s", "s", "$(id)", "T")).toThrow(/can't save/);
  });

  it("reports the Project's own remote, so an import saves back where it came from", () => {
    const script = bundleScript("my-site");
    expect(script).toContain("git config --get remote.origin.url");
    expect(script).toContain(ORIGIN_MARKER);
    expect(parseOrigin(`${ORIGIN_MARKER} https://github.com/CaelTC/Claudebox.git`)).toBe(
      "https://github.com/CaelTC/Claudebox.git",
    );
    expect(parseOrigin("no remote here")).toBeUndefined();
  });

  it("only recognises a plain GitHub remote as a destination", () => {
    // This URL lives in .git/config, which Claude can write, and it decides where
    // the token pushes. Everything unrecognised falls back to a slug-named repo.
    for (const url of [
      "https://github.com/CaelTC/Claudebox.git",
      "git@github.com:CaelTC/Claudebox.git",
      "https://github.com/CaelTC/Claudebox",
    ]) {
      expect(parseGithubRemote(url)).toEqual({ owner: "CaelTC", repo: "Claudebox" });
    }
    for (const url of [
      "https://gitlab.com/CaelTC/Claudebox.git", // another host
      "https://x:y@github.com/CaelTC/Claudebox.git", // credentials smuggled in
      "https://github.com/CaelTC/Claudebox.git evil", // a second word
      "https://github.com.evil.example/a/b.git",
      "https://github.com/CaelTC/../../etc",
    ]) {
      expect(parseGithubRemote(url)).toBeUndefined();
    }
  });

  it("scopes the credential helper to github.com and validates the destination", () => {
    const script = pushScript("CaelTC", "Claudebox", "my-site", "main", "T");
    expect(script).toContain("credential.https://github.com.helper=");
    expect(script).toContain('"https://github.com/CaelTC/Claudebox.git"');
    expect(() => pushScript("a;id", "r", "s", "main", "T")).toThrow(/not a usable/);
    expect(() => pushScript("a", "r`id`", "s", "main", "T")).toThrow(/not a usable/);
  });

  it("never publishes a .env, whatever the Project ignores", () => {
    // The Project usually has no .gitignore of its own, so this list is the only
    // thing standing between a Sandbox User's API keys and a GitHub push. It is
    // applied for the publish `add` only, so nothing is written into the Project.
    const script = bundleScript("my-site");
    expect(script).toContain("core.excludesfile=");
    expect(script).not.toMatch(/>\s*[^ ]*\/workspace/); // nothing written into the Project
    for (const pattern of [".env", ".env.*", "*.pem", "node_modules/"]) {
      expect(script).toContain(`'${pattern}'`);
    }
  });

  it("pushes an explicit refspec into a repo it created itself", () => {
    const script = pushScript("alice", "my-site", "my-site", "feature/x", "CLAUDEBOX_GIT_TOKEN");
    expect(script).toContain("git init -q --bare /tmp/publish");
    expect(script).toContain("refs/heads/feature/x:refs/heads/feature/x");
    expect(script).not.toContain("--force");
    // The token goes through a helper reading the env — a URL would put it in
    // this container's own argv, readable from /proc.
    expect(script).not.toMatch(/https:\/\/[^ ]*@github\.com/);
  });
});
