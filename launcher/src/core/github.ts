import {
  BOX_IMAGE,
  GIT_SCRATCH_DIR,
  GIT_SCRATCH_VOLUME,
  WORKSPACE_DIR,
  WORKSPACE_VOLUME,
} from "./config";
import { assertValidSlug } from "./projects";

/**
 * Save to GitHub (ADR 0006). This module holds every DECISION — the device-flow
 * state machine, the argv of both publish containers, and the invariant that
 * keeps them apart; the `fetch` calls and the spawns live in `main/github.ts`.
 *
 * The Launcher holds an OAuth token with `repo` scope for the Sandbox User's own
 * GitHub account. That token can read and write every private repository they
 * own, so it must never enter the Box — where Claude runs with permissions
 * bypassed and open egress to github.com, and `printenv` plus `curl` is the
 * whole exfiltration chain. An env var is not a hiding place.
 *
 * Handing the token to a container that mounts the Workspace does not help
 * either, because Claude controls `/workspace/<slug>/.git`:
 *   - `.git/hooks/pre-push` executes in that container, with the token in its
 *     environment (or readable from the parent's `/proc/<pid>/cmdline`);
 *   - `.git/config` can set `credential.helper` — which git HANDS the credential
 *     to on success — as well as `core.fsmonitor` and `uploadpack.packObjectsHook`,
 *     both of which run commands.
 * Git has no "ignore repo-local config" switch, so no combination of `-c` flags
 * closes this. The separation has to be structural, which is what this module
 * builds: two containers, and `assertNoWorkspaceMount` guarding the credentialed
 * one.
 */

// --- The device flow (https://github.com/login/device) ----------------------

export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * `repo` and nothing more. It is broad — read+write on every private repository
 * the user owns — and that breadth is stated in the ADR and in the connect
 * sheet, because `public_repo` cannot create the private repo this feature
 * publishes into and GitHub Apps cannot create a repository under a personal
 * account at all.
 */
export const GITHUB_SCOPE = "repo";

/** GitHub's documented default when a response omits `interval`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export interface DeviceCode {
  /** Secret half — polled with, never shown. */
  readonly deviceCode: string;
  /** The 8-characters-plus-hyphen code the Sandbox User types at GitHub. */
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}

/**
 * Parse GitHub's device-code response. Every field is required except the two
 * timings, which fall back to GitHub's documented defaults — a missing
 * `device_code` or `user_code` is a broken flow and must say so here rather than
 * surface later as a poll that can never succeed.
 */
export function parseDeviceCode(body: unknown): DeviceCode {
  const b = body as Record<string, unknown>;
  const deviceCode = typeof b?.device_code === "string" ? b.device_code : "";
  const userCode = typeof b?.user_code === "string" ? b.user_code : "";

  if (!deviceCode || !userCode) {
    const error = typeof b?.error === "string" ? b.error : "";
    // The one error a maintainer will actually hit, named so they can act on it.
    if (error === "device_flow_disabled") {
      throw new Error(
        "This Agentbox build's GitHub App does not have Device Flow enabled. " +
          "Tick 'Enable Device Flow' in its settings on GitHub.",
      );
    }
    throw new Error(`GitHub did not return a device code${error ? ` (${error})` : ""}.`);
  }

  return {
    deviceCode,
    userCode,
    verificationUri:
      typeof b.verification_uri === "string" ? b.verification_uri : "https://github.com/login/device",
    intervalSeconds:
      typeof b.interval === "number" ? b.interval : DEFAULT_POLL_INTERVAL_SECONDS,
    expiresInSeconds: typeof b.expires_in === "number" ? b.expires_in : 900,
  };
}

export type PollOutcome =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "wait"; readonly intervalSeconds: number }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Classify one poll of the access-token endpoint. `intervalSeconds` is the
 * current polling interval, returned unchanged on `authorization_pending` and
 * grown on `slow_down` — GitHub sends a new `interval` with that error, and adds
 * 5 seconds when it doesn't.
 *
 * Anything unrecognised is a failure rather than another wait: a poll loop that
 * treats unknown errors as "keep trying" spins for the full 15 minutes showing a
 * code that will never work.
 */
export function classifyPoll(body: unknown, intervalSeconds: number): PollOutcome {
  const b = body as Record<string, unknown>;

  if (typeof b?.access_token === "string" && b.access_token.length > 0) {
    return { kind: "token", token: b.access_token };
  }

  switch (b?.error) {
    case "authorization_pending":
      return { kind: "wait", intervalSeconds };
    case "slow_down":
      return {
        kind: "wait",
        intervalSeconds: typeof b.interval === "number" ? b.interval : intervalSeconds + 5,
      };
    case "expired_token":
      return { kind: "failed", message: "That code expired. Start again to get a new one." };
    case "access_denied":
      return { kind: "failed", message: "You cancelled the sign-in on GitHub." };
    default: {
      const description =
        typeof b?.error_description === "string" ? b.error_description : String(b?.error ?? "");
      return {
        kind: "failed",
        message: description ? `GitHub refused the sign-in: ${description}` : "GitHub refused the sign-in.",
      };
    }
  }
}

// --- What gets published ----------------------------------------------------

/** The branch a Project gets if it has no git repo yet, matching `git init` defaults. */
export const DEFAULT_BRANCH = "main";

/**
 * The line container A prints so the host learns which branch to push. Marked
 * because the Box image's entrypoint writes to stdout too, so "the last line" is
 * not a contract.
 */
export const BRANCH_MARKER = "agentbox-branch";

/** The same, for the Project's `origin` remote — absent when it has none. */
export const ORIGIN_MARKER = "agentbox-origin";

function parseMarked(stdout: string, marker: string): string | undefined {
  for (const line of stdout.split("\n").reverse()) {
    const [found, ...rest] = line.trim().split(" ");
    if (found === marker && rest.length === 1) return rest[0];
  }
  return undefined;
}

/** Read the branch container A reported, or undefined if it said nothing usable. */
export function parseBranch(stdout: string): string | undefined {
  return parseMarked(stdout, BRANCH_MARKER);
}

/** Read the Project's `origin` URL, or undefined if it has no remote. */
export function parseOrigin(stdout: string): string | undefined {
  return parseMarked(stdout, ORIGIN_MARKER);
}

/**
 * The `owner/repo` of a GitHub remote, or undefined for anything else — another
 * host, a URL with credentials in it, a name that is not plain GitHub-shaped.
 *
 * This URL comes out of `/workspace/<slug>/.git/config`, which Claude can write,
 * so it is untrusted input twice over: it decides which repository the token
 * pushes to, and both halves are embedded in the credentialed container's script.
 * Falling through to undefined (publish to a repo named after the slug instead)
 * is always the safe answer; the caller additionally asks GitHub whether the
 * token may push there at all.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/**
 * A branch name is chosen INSIDE the Box — by the Sandbox User or by Claude — and
 * then gets embedded in the credentialed container's script, so it is untrusted
 * input at a trust boundary. This is deliberately narrower than what git itself
 * accepts: no spaces, quotes, `$`, or `;` means nothing here can end a shell word
 * and start a command.
 */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function assertValidBranch(branch: string): string {
  if (!BRANCH_RE.test(branch) || branch.includes("..") || branch.endsWith(".lock")) {
    throw new Error(
      `Agentbox can't save the branch '${branch}' — rename it to letters, numbers, dots, dashes and slashes.`,
    );
  }
  return branch;
}

/**
 * Never published, whatever the Project's own `.gitignore` says or doesn't.
 *
 * Two different reasons, and the second is the load-bearing one:
 *   - `node_modules` and friends would turn one `npm install` into a
 *     several-hundred-megabyte push;
 *   - a `.env` is where a Sandbox User's API keys live, and Agentbox pushing
 *     one to GitHub would be Agentbox exfiltrating a credential on their
 *     behalf. A Project with no `.gitignore` is the normal case here — most are
 *     created by Claude from a blank Project — so "their .gitignore will catch
 *     it" is not a defence that exists.
 *
 * Build output (`dist/`, `build/`) is deliberately NOT here: for a static site,
 * that IS the thing being saved.
 *
 * Applied as a `core.excludesfile` for the publish `add` only, so nothing is
 * written into the Project and the Sandbox User's own git inside the Box behaves
 * exactly as before. Their `.gitignore` files still apply on top. A file already
 * TRACKED in their repo is unaffected — that is ordinary git, and by then they
 * have committed it themselves.
 *
 * ponytail: a fixed list. Extend it rather than growing a detector.
 */
export const PUBLISH_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".DS_Store",
  ".env",
  ".env.*",
  "*.pem",
  "id_rsa",
  "id_ed25519",
];

/** Where the Workspace-side container writes a Project's bundle. */
export function bundlePath(slug: string): string {
  return `${GIT_SCRATCH_DIR}/${assertValidSlug(slug)}.bundle`;
}

/** Where container A writes the exclude list, in its own filesystem, not the Project's. */
const EXCLUDES_FILE = "/tmp/agentbox-excludes";

/**
 * The GitHub repository name for a Project that has no remote of its own. The
 * SLUG, never the friendly name: the name is read from metadata inside the Box
 * and so Claude can write it, while the slug is `[a-z0-9-]` by construction and
 * re-validated here.
 */
export function repoNameFor(slug: string): string {
  return assertValidSlug(slug);
}

/** Network flags shared with the long-lived Box, so the Egress Policy covers both publish containers. */
const NETWORK_ARGS = [
  "--cap-add",
  "NET_ADMIN",
  "--sysctl",
  "net.ipv6.conf.all.disable_ipv6=1",
  "--sysctl",
  "net.ipv6.conf.default.disable_ipv6=1",
];

/**
 * Container A's script: commit the Project in its own repository and bundle the
 * branch that is checked out. Ordinary git — a Project on `main` publishes
 * `main`, a Project on `feature/x` publishes `feature/x`, and the commit lands in
 * the history the Sandbox User sees inside the Box.
 *
 * Runs with NO credential, so hostile `.git` content here gains exactly the
 * privilege Claude already has — which is why the commit, the one step that must
 * touch Claude's filesystem, happens on this side of the wall.
 *
 * Exit 3 means "nothing to save yet" (an empty Project) and exit 4 means detached
 * HEAD, so there is no branch to push. Both are reported as sentences rather than
 * left to fail somewhere deeper.
 */
export function bundleScript(slug: string): string {
  const dir = `${WORKSPACE_DIR}/${assertValidSlug(slug)}`;
  const bundle = bundlePath(slug);

  return [
    "set -e",
    `cd "${dir}"`,
    `[ -d .git ] || git init -q -b ${DEFAULT_BRANCH}`,
    // Excludes live in this container's own filesystem, applied for this `add`
    // only: no .gitignore is written into the Project and the Sandbox User's git
    // behaviour inside the Box is unchanged.
    `printf '%s\\n' ${PUBLISH_EXCLUDES.map((p) => `'${p}'`).join(" ")} > ${EXCLUDES_FILE}`,
    `git -c core.excludesfile=${EXCLUDES_FILE} add -A`,
    // Identity on the command line, never written into the Project's config. A
    // no-op commit exits 1, which is not an error here: the Sandbox User may
    // simply be re-publishing something unchanged.
    "git -c user.name=Agentbox -c user.email=agentbox@localhost " +
      "commit -q -m 'Saved from Agentbox' || true",
    "git rev-parse -q --verify HEAD >/dev/null 2>&1 || exit 3",
    'branch=$(git symbolic-ref -q --short HEAD) || exit 4',
    `rm -f "${bundle}"`,
    `git bundle create -q "${bundle}" "refs/heads/$branch"`,
    // How the host learns where to push. Marked, because the image's entrypoint
    // writes to stdout too. An imported Project keeps its own remote (ADR 0005),
    // and saving should go back there rather than to a new repo — the host
    // decides whether to trust it.
    `printf '${BRANCH_MARKER} %s\\n' "$branch"`,
    "origin=$(git config --get remote.origin.url || true)",
    `[ -z "$origin" ] || printf '${ORIGIN_MARKER} %s\\n' "$origin"`,
  ].join("\n");
}

/** Exit code `bundleScript` uses for "this Project has nothing in it yet". */
export const NOTHING_TO_SAVE_EXIT = 3;

/** Exit code for a detached HEAD — a real git state, with no branch to push. */
export const DETACHED_HEAD_EXIT = 4;

export function bundleRunArgs(slug: string, image: string = BOX_IMAGE): string[] {
  return [
    "run",
    "--rm",
    ...NETWORK_ARGS,
    "-v",
    `${WORKSPACE_VOLUME}:${WORKSPACE_DIR}`,
    "-v",
    `${GIT_SCRATCH_VOLUME}:${GIT_SCRATCH_DIR}`,
    image,
    "sh",
    "-c",
    bundleScript(slug),
  ];
}

/**
 * Container B's script: push the bundle to GitHub. It fetches into a bare repo
 * it creates itself, so the only git config consulted is the one this script
 * wrote — nothing from the Workspace is read, and nothing from the Workspace is
 * even mounted.
 *
 * A bundle is a packfile plus a ref list: fetching one imports no config and
 * runs no hook. The refspec is explicit on both ends, so a crafted ref name
 * inside the bundle cannot cross into the push.
 *
 * The token reaches git through a credential helper reading the environment,
 * never through the URL — a URL would put it in this container's process argv.
 * The helper is scoped to `github.com`, so even a destination that somehow got
 * past validation could not be handed the token.
 */
export function pushScript(
  owner: string,
  repo: string,
  slug: string,
  branch: string,
  tokenVar: string,
): string {
  const bundle = bundlePath(slug);
  // All three were chosen inside the Box — the branch by whoever checked it out,
  // the owner and repo by the Project's own `origin` — and are about to be
  // embedded in the one script that runs with the credential.
  const ref = `refs/heads/${assertValidBranch(branch)}`;
  const target = `${assertValidRepoPart(owner)}/${assertValidRepoPart(repo)}`;
  const helper =
    `!f(){ echo username=x-access-token; echo password=\${${tokenVar}}; }; f`;

  return [
    "set -e",
    "git init -q --bare /tmp/publish",
    `git -C /tmp/publish fetch -q "${bundle}" ${ref}:${ref}`,
    `git -C /tmp/publish -c 'credential.https://github.com.helper=${helper}' push -q ` +
      `"https://github.com/${target}.git" ${ref}:${ref}`,
  ].join("\n");
}

/** An owner or repository name, narrow enough that it cannot end a shell word. */
export function assertValidRepoPart(part: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part.includes("..")) {
    throw new Error(`'${part}' is not a usable GitHub name.`);
  }
  return part;
}

/**
 * Container B's argv. The Workspace volume is absent BY CONSTRUCTION, and
 * `assertNoWorkspaceMount` below makes that a checked precondition rather than a
 * property of this function that a later edit could quietly drop.
 *
 * `-e NAME` without a value passes the variable through from the engine CLI's
 * own environment, so the token never appears in the HOST's process list either.
 */
export function pushRunArgs(
  owner: string,
  repo: string,
  slug: string,
  branch: string,
  tokenVar: string,
  image: string = BOX_IMAGE,
): string[] {
  const args = [
    "run",
    "--rm",
    ...NETWORK_ARGS,
    "-e",
    tokenVar,
    "-v",
    `${GIT_SCRATCH_VOLUME}:${GIT_SCRATCH_DIR}`,
    image,
    "sh",
    "-c",
    pushScript(owner, repo, slug, branch, tokenVar),
  ];
  assertNoWorkspaceMount(args);
  return args;
}

/**
 * Guard: refuse to run a credentialed container that mounts the Workspace. The
 * mirror of `assertNoHostMounts` in `core/box.ts`, and the load-bearing half of
 * ADR 0006 — it is what turns "the token and Claude's filesystem never meet"
 * from a convention into an enforced precondition.
 */
export function assertNoWorkspaceMount(runArgs: readonly string[]): void {
  for (let i = 0; i < runArgs.length - 1; i++) {
    if (runArgs[i] === "-v" || runArgs[i] === "--volume") {
      const source = (runArgs[i + 1] ?? "").split(":")[0] ?? "";
      if (source === WORKSPACE_VOLUME) {
        throw new Error(
          `Refusing to run a container that holds the GitHub token AND mounts ` +
            `'${WORKSPACE_VOLUME}': Claude controls .git in there, and a pre-push ` +
            `hook would read the token (ADR 0006).`,
        );
      }
    }
  }
}

/** The repository page a Sandbox User is shown after a successful publish. */
export function repoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

/** What one publish did, for the confirmation the Sandbox User sees. */
export interface PublishResult {
  readonly owner: string;
  readonly repo: string;
  readonly url: string;
  /** The branch that was pushed — the one checked out in the Box. */
  readonly branch: string;
  /** True the first time a Project is published, so the copy can say "created". */
  readonly created: boolean;
}
