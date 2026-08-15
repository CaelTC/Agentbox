import { beforeEach, describe, expect, it } from "vitest";
import { codexUpdate, codexVersion, isNewerVersion } from "../src/core/codex";
import { checkCodexUpdate, forgetCodexUpdate } from "../src/main/codex";
import { fakeBox } from "./fake-box";

/**
 * The "Codex update available" banner (backlog: codex-update-notify). Claude
 * Code is updated on every launch; Codex is not, because `npm install -g` costs
 * its ~15s whether or not anything changed — so the launch compares two version
 * strings instead, and everything that can go wrong with THAT has to end in
 * silence rather than in a wrong banner or a failed launch.
 *
 * The comparison is pure (core/codex.ts) and the two reads go through the
 * Box-exec seam, so both halves are assertable with no container anywhere.
 */

describe("codexVersion", () => {
  it("reads the version out of what each command actually prints", () => {
    expect(codexVersion("codex-cli 0.9.1\n")).toBe("0.9.1"); // codex --version
    expect(codexVersion("0.9.1\n")).toBe("0.9.1"); // npm view … version
  });

  it("keeps a prerelease suffix intact — the banner quotes this back", () => {
    expect(codexVersion("codex-cli 1.0.0-alpha.3")).toBe("1.0.0-alpha.3");
  });

  // Every one of these is a way the check comes back useless, and all of them
  // have to mean "no banner" rather than "banner with nonsense in it".
  it("finds nothing in output that holds no version", () => {
    expect(codexVersion("")).toBeUndefined();
    expect(codexVersion("codex: command not found")).toBeUndefined();
    expect(codexVersion("npm error code E404")).toBeUndefined();
  });
});

describe("isNewerVersion", () => {
  // The reason this is not a string comparison: "0.10.0" < "0.9.1" as text, and
  // that leaves a Sandbox User pinned to an old Codex with nothing to click.
  it("ranks the fields as numbers, not as text", () => {
    expect(isNewerVersion("0.9.1", "0.10.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.1")).toBe(false);
    expect(isNewerVersion("1.2.3", "1.2.10")).toBe(true);
  });

  it("offers nothing for the version already installed, or an older one", () => {
    expect(isNewerVersion("0.9.1", "0.9.1")).toBe(false);
    expect(isNewerVersion("0.9.1", "0.9.0")).toBe(false);
  });

  it("compares each field in turn, most significant first", () => {
    expect(isNewerVersion("0.9.9", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(false);
  });

  // npm's `latest` tag never points at a prerelease, so someone running one put
  // it there on purpose: the release fields are compared and the tail ignored.
  it("ignores a prerelease tail rather than guessing what it outranks", () => {
    expect(isNewerVersion("1.0.0-alpha.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0-alpha.1", "1.0.1")).toBe(true);
  });

  it("ranks nothing it cannot read as a number", () => {
    expect(isNewerVersion("nightly", "0.9.1")).toBe(false);
  });
});

describe("codexUpdate", () => {
  it("is the newer version when there is one", () => {
    expect(codexUpdate("codex-cli 0.9.1", "0.10.0")).toBe("0.10.0");
  });

  it("is nothing when the Box is level with the registry", () => {
    expect(codexUpdate("codex-cli 0.10.0", "0.10.0")).toBeUndefined();
  });

  it("is nothing when either half failed to answer", () => {
    expect(codexUpdate("", "0.10.0")).toBeUndefined();
    expect(codexUpdate("codex-cli 0.9.1", "npm error network ETIMEDOUT")).toBeUndefined();
  });
});

describe("checkCodexUpdate", () => {
  // The answer is memoized for the whole process (one launch check, many asks),
  // so each test starts from a Launcher that has not looked yet.
  beforeEach(() => forgetCodexUpdate());

  const answers = (installed: string, latest: string) =>
    fakeBox((_op, argv) => (argv[0] === "codex" ? installed : latest));

  it("compares the Box's Codex against the registry, both read inside the Box", async () => {
    const box = answers("codex-cli 0.9.1\n", "0.10.0\n");

    expect(await checkCodexUpdate(box)).toBe("0.10.0");
    // In the Box on purpose: the registry lookup then leaves by the same route,
    // under the same Egress Policy, as everything else Agentbox fetches — and
    // the host is not assumed to have npm on a Finder-launched PATH at all.
    expect(box.calls).toEqual([
      "tryExec codex --version",
      "tryExec npm view @openai/codex version",
    ]);
  });

  it("offers nothing when the Box already has the latest", async () => {
    expect(await checkCodexUpdate(answers("codex-cli 0.10.0", "0.10.0"))).toBeUndefined();
  });

  /**
   * The whole failure policy in one test: a Box with no Codex in it, a registry
   * behind a network that is down, a container that went away mid-check. None of
   * them may throw — the launch runs this — and none of them may put a word on
   * screen, because a Launcher with nothing to say about Codex says nothing.
   */
  it("stays silent, never throws, when the Box or the registry cannot answer", async () => {
    const noCodex = fakeBox((_op, argv) =>
      argv[0] === "codex" ? new Error("executable file not found") : "0.10.0",
    );
    expect(await checkCodexUpdate(noCodex)).toBeUndefined();

    forgetCodexUpdate();
    const noRegistry = fakeBox((_op, argv) =>
      argv[0] === "codex" ? "codex-cli 0.9.1" : new Error("network ETIMEDOUT"),
    );
    expect(await checkCodexUpdate(noRegistry)).toBeUndefined();
  });

  /**
   * One check, two askers. The launch starts it and the home screen asks moments
   * later; memoizing the PROMISE (not the value) is what lets the second ask
   * WAIT for the first one's answer instead of racing it to "nothing yet" — the
   * race that would leave the banner off the screen it was meant for.
   */
  it("answers a second asker from the first check rather than reading again", async () => {
    const box = answers("codex-cli 0.9.1", "0.10.0");

    const [first, second] = await Promise.all([checkCodexUpdate(box), checkCodexUpdate(box)]);

    expect([first, second]).toEqual(["0.10.0", "0.10.0"]);
    expect(box.calls).toHaveLength(2); // the two reads of ONE check
  });

  // A recreate drops the container back to the Codex baked into the image, so
  // the answer from before it is about a container that no longer exists.
  it("re-reads the Box once the recreate has been declared", async () => {
    const box = answers("codex-cli 0.9.1", "0.10.0");
    await checkCodexUpdate(box);

    forgetCodexUpdate();
    await checkCodexUpdate(box);

    expect(box.calls).toHaveLength(4);
  });
});
