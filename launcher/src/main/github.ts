import { safeStorage } from "electron";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ENGINE_CLI, GITHUB_CLIENT_ID } from "../core/config";
import {
  ACCESS_TOKEN_URL,
  DEVICE_CODE_URL,
  DEVICE_GRANT_TYPE,
  GITHUB_SCOPE,
  DETACHED_HEAD_EXIT,
  NOTHING_TO_SAVE_EXIT,
  bundleRunArgs,
  classifyPoll,
  parseBranch,
  parseDeviceCode,
  parseGithubRemote,
  parseOrigin,
  pushRunArgs,
  repoNameFor,
  repoUrl,
  type DeviceCode,
  type PublishResult,
} from "../core/github";
import { run } from "./exec";
import { githubTokenPath } from "./paths";

/**
 * The host half of Save to GitHub (ADR 0006). The token lives HERE — encrypted at
 * rest with the OS keystore, held in the trusted Launcher — and reaches git only
 * inside the credentialed container that `core/github.ts` builds and guards.
 */

const API = "https://api.github.com";
const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

/** The env var the token is handed to the credentialed container through. */
const TOKEN_VAR = "AGENTBOX_GIT_TOKEN";

export interface GithubStatus {
  /** False when this build has no OAuth App client id — connecting is impossible. */
  readonly configured: boolean;
  readonly connected: boolean;
  /** The GitHub login of the connected account, for "Connected as alice". */
  readonly login?: string;
}

interface StoredAccount {
  readonly login: string;
  /** base64 of `safeStorage.encryptString`. Never a plaintext token. */
  readonly token: string;
}

// --- Token at rest ----------------------------------------------------------

function readAccount(): StoredAccount | undefined {
  try {
    const raw = JSON.parse(readFileSync(githubTokenPath(), "utf8")) as StoredAccount;
    if (typeof raw?.login !== "string" || typeof raw?.token !== "string") return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function readToken(): string {
  const account = readAccount();
  if (!account) throw new Error("No GitHub Account is connected.");
  try {
    return safeStorage.decryptString(Buffer.from(account.token, "base64"));
  } catch {
    // Keychain entry gone, or a different machine/user. Not recoverable, and a
    // stale file would keep the UI claiming "connected" forever.
    throw new Error("The saved GitHub sign-in could not be read. Connect GitHub again.");
  }
}

function writeAccount(login: string, token: string): void {
  // Refusing to store beats storing in the clear: a plaintext `repo` token in a
  // dotfile is exactly what this design exists to avoid.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "This computer has no secure keystore available, so Agentbox will not save a GitHub sign-in.",
    );
  }
  const path = githubTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  const stored: StoredAccount = {
    login,
    token: safeStorage.encryptString(token).toString("base64"),
  };
  writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
}

export function githubStatus(): GithubStatus {
  const account = readAccount();
  return {
    configured: GITHUB_CLIENT_ID.length > 0,
    connected: Boolean(account),
    ...(account ? { login: account.login } : {}),
  };
}

export function disconnectGithub(): void {
  rmSync(githubTokenPath(), { force: true });
  pending = undefined;
}

// --- The device flow --------------------------------------------------------

/**
 * The in-flight device code. Module state so the renderer can call
 * `startGithubLogin` then `awaitGithubLogin` over the plain request/response IPC
 * it already has — the secret half never crosses to the renderer.
 */
let pending: DeviceCode | undefined;

export async function startGithubLogin(): Promise<Omit<DeviceCode, "deviceCode">> {
  if (!GITHUB_CLIENT_ID) {
    throw new Error(
      "This Agentbox build has no GitHub App configured, so it cannot connect an account.",
    );
  }
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPE }),
  });
  const code = parseDeviceCode(await res.json());
  pending = code;
  const { deviceCode: _secret, ...shown } = code;
  return shown;
}

/**
 * Poll until GitHub says yes, no, or the code expires. Resolves with the account
 * login; the token goes straight to the keystore and is never returned.
 */
export async function awaitGithubLogin(): Promise<GithubStatus> {
  const code = pending;
  if (!code) throw new Error("No GitHub sign-in is in progress.");

  let interval = code.intervalSeconds;
  const deadline = Date.now() + code.expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: code.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    });
    const outcome = classifyPoll(await res.json(), interval);

    if (outcome.kind === "wait") {
      interval = outcome.intervalSeconds;
      continue;
    }
    pending = undefined;
    if (outcome.kind === "failed") throw new Error(outcome.message);

    const login = await githubLogin(outcome.token);
    writeAccount(login, outcome.token);
    return { configured: true, connected: true, login };
  }

  pending = undefined;
  throw new Error("That code expired. Start again to get a new one.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubLogin(token: string): Promise<string> {
  const user = (await api("GET", "/user", token)) as { login?: string };
  if (!user?.login) throw new Error("GitHub did not say which account was signed in.");
  return user.login;
}

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (json as { message?: string })?.message ?? res.statusText;
    throw new Error(`GitHub refused the request (${res.status}): ${message}`);
  }
  return json;
}

// --- Publishing -------------------------------------------------------------

/**
 * Publish a Project to the connected account, creating the private repo the
 * first time. Two containers, in order, and the token only ever reaches the
 * second — see `core/github.ts` for why that split is the whole defence.
 */
export async function saveToGithub(slug: string): Promise<PublishResult> {
  const token = readToken();
  const login = readAccount()!.login;

  const bundled = await run(ENGINE_CLI, bundleRunArgs(slug));
  if (bundled.code === NOTHING_TO_SAVE_EXIT) {
    throw new Error("There is nothing to save yet — this Project has no files in it.");
  }
  if (bundled.code === DETACHED_HEAD_EXIT) {
    throw new Error(
      "This Project isn't on a branch (git calls it a detached HEAD), so there's nothing to push. " +
        "Ask Claude to check out a branch first.",
    );
  }
  if (bundled.code !== 0) {
    throw new Error(`Could not package this Project: ${bundled.stderr.trim()}`);
  }

  // Which branch to push is decided inside the Box, by whatever is checked out
  // there — so it is read back rather than assumed, and validated before it
  // reaches the credentialed container.
  const branch = parseBranch(bundled.stdout);
  if (!branch) throw new Error("Couldn't tell which branch this Project is on.");

  const { owner, repo, created } = await destination(bundled.stdout, login, slug, token);

  const pushed = await run(ENGINE_CLI, pushRunArgs(owner, repo, slug, branch, TOKEN_VAR), {
    [TOKEN_VAR]: token,
  });
  if (pushed.code !== 0) {
    throw new Error(pushFailure(pushed.stderr, branch));
  }

  return { owner, repo, url: repoUrl(owner, repo), branch, created };
}

/**
 * Where this Project publishes. An imported Project keeps its own `origin`
 * (ADR 0005), and saving should go back to the repository it came from rather
 * than to a second one named after the slug — that is what "save" means to
 * someone who imported a repo.
 *
 * The remote is Claude-writable, so it is not taken on trust: it must parse as a
 * GitHub repository, and GitHub itself must say this token has push permission
 * on it. That answer also covers repositories owned by an organisation, which no
 * comparison against the connected login could. Anything else falls back to a
 * private repo named after the slug.
 */
async function destination(
  stdout: string,
  login: string,
  slug: string,
  token: string,
): Promise<{ owner: string; repo: string; created: boolean }> {
  const origin = parseOrigin(stdout);
  const remote = origin ? parseGithubRemote(origin) : undefined;
  if (remote && (await canPush(remote.owner, remote.repo, token))) {
    return { ...remote, created: false };
  }
  const repo = repoNameFor(slug);
  return { owner: login, repo, created: await ensureRepo(repo, token) };
}

async function canPush(owner: string, repo: string, token: string): Promise<boolean> {
  try {
    const info = (await api("GET", `/repos/${owner}/${repo}`, token)) as {
      permissions?: { push?: boolean };
    };
    return info?.permissions?.push === true;
  } catch {
    // Gone, private to someone else, or the token cannot see it — all of which
    // mean "not our destination", not "fail the save".
    return false;
  }
}

/** True if the repo was created by this call (so the UI can say so). */
async function ensureRepo(repo: string, token: string): Promise<boolean> {
  try {
    await api("POST", "/user/repos", token, {
      name: repo,
      private: true,
      description: "Saved from Agentbox",
    });
    return true;
  } catch (err) {
    // 422 (name taken) / 409 mean it is already there — which is the normal case
    // on every publish after the first.
    if (/\((422|409)\)/.test(String(err))) return false;
    throw err;
  }
}

function pushFailure(stderr: string, branch: string): string {
  if (/non-fast-forward|fetch first|rejected/i.test(stderr)) {
    // Never force: the remote history is the Sandbox User's, not ours to discard.
    return `GitHub's ${branch} has changes Agentbox doesn't — it was changed somewhere else, so nothing was saved.`;
  }
  return `Could not save to GitHub: ${stderr.trim()}`;
}
