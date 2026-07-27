import type { DeleteListing, DeleteResult } from "../core/delete";
import type { ExportListing, ExportResult } from "../core/export";
import type { PublishResult } from "../core/github";
import type { ImportListing } from "../core/import";
import type { Project } from "../core/projects";
import type { UploadTarget } from "../core/upload";

/**
 * The contract between the trusted main process and the renderer. Everything
 * the home screen can do goes through this narrow, typed surface — the renderer
 * never touches Docker, the filesystem, or child processes directly.
 */
export interface ClaudeboxApi {
  listProjects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  /**
   * Bring the Box up, ensure the Project's session via the funnel, and show it
   * in the Launcher's own session window. Idempotent per Project: called again
   * while that Project's window is open, it raises that window instead of
   * opening a second view of the same session.
   */
  openSession(slug: string): Promise<void>;
  /** Open a native file picker and copy the chosen files into the Project. */
  upload(slug: string): Promise<UploadTarget[]>;
  /** Detect the served port and open it in the host's browser. */
  openPreview(): Promise<{ opened: boolean; url?: string }>;

  /**
   * The Project's files, classified, so the Launcher can render the checkbox
   * list. Built by the Launcher from what it enumerated inside the Box — the Box
   * itself never names what crosses or where it lands.
   */
  listExportFiles(slug: string): Promise<ExportListing>;
  /**
   * Copy the ticked files out of the Box onto the user's computer (Export). The
   * selection is re-validated in the trusted layer before anything is written.
   */
  saveToComputer(slug: string, pick: string[]): Promise<ExportResult>;
  /** Open the Project's saved folder in Finder and report when it was last saved. */
  showSavedFiles(slug: string): Promise<SavedFolder>;

  /**
   * Project Import (ticket 09): open a native folder picker and measure what
   * bringing it in would cost — for the one confirmation sheet. Undefined if
   * the Sandbox User cancels the picker.
   */
  planImport(): Promise<ImportListing | undefined>;
  /**
   * "Bring it in" on the confirmation sheet: copy the folder into the Box as a
   * new Project. Re-measures the folder itself rather than trusting the
   * listing above, exactly as `saveToComputer` re-validates its selection.
   */
  importFolder(folder: string): Promise<Project>;

  /**
   * Save to GitHub (ADR 0006). The token lives in the Launcher and never enters
   * the Box, so all four of these are host-side operations the renderer only
   * triggers — no token ever crosses this bridge in either direction.
   */
  githubStatus(): Promise<GithubStatus>;
  /** Begin the device flow: returns the code to type at github.com/login/device. */
  startGithubLogin(): Promise<GithubDeviceCode>;
  /** Resolve once the Sandbox User has approved (or GitHub has refused) that code. */
  awaitGithubLogin(): Promise<GithubStatus>;
  disconnectGithub(): Promise<GithubStatus>;
  /** Publish the Project to a private repo on the connected account. */
  saveToGithub(slug: string): Promise<PublishResult>;

  /**
   * Update Claudebox (ADR 0002): pull the public Box definition and, if it
   * changed, rebuild the image and restart the sandbox on it. Confirmed by a
   * native dialog in the trusted layer first — undefined if that is cancelled.
   *
   * Resolves with the sentence to show. The renderer is a classic script and
   * cannot import from `core/`, so the wording is composed by the tested
   * `updateMessage()` rather than reassembled from an enum out here.
   */
  updateBox(): Promise<string | undefined>;

  /**
   * Measure what deleting this Project would destroy, for the one confirmation
   * sheet — file count, size, and whether any of it was ever saved out.
   */
  planDelete(slug: string): Promise<DeleteListing>;
  /**
   * Delete the Project and everything in it, permanently. `typed` is the name
   * the Sandbox User typed into the sheet; the trusted layer re-checks it
   * against the Project's real name before removing anything, exactly as
   * `saveToComputer` re-validates its selection.
   */
  deleteProject(slug: string, typed: string): Promise<DeleteResult>;

  /**
   * Resolves once the Engine + Box are up so the home screen can safely query
   * Projects. Rejects (with a message to show) if bootstrap failed.
   */
  onBootstrap(listener: (result: BootstrapStatus) => void): void;
}

export interface GithubStatus {
  /** False when this build ships no GitHub App client id — connecting is impossible. */
  configured: boolean;
  connected: boolean;
  login?: string;
}

/** The public half of a device code. The secret `device_code` stays in main. */
export interface GithubDeviceCode {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

/**
 * What bootstrap tells the renderer. THREE states, not two: a launch that has to
 * build the Box image is minutes long, and "Warming the room." with nothing
 * moving under it is indistinguishable from a Launcher that has hung (issue #27).
 *
 * `working` arrives any number of times — it is the sub-line of the starting
 * screen, replaced in place. A terminal status arrives exactly ONCE: `ok: true`
 * is what makes the renderer draw the home screen, so a second would redraw it
 * under whatever the Sandbox User was doing by then.
 *
 * `notice` is the launch's non-fatal bad news — a rebuild that failed, or the
 * integrity gate refusing an untrusted definition — on a launch that went on to
 * succeed on the last-known-good image. It rides on the ready status rather than
 * being a status of its own, because it changes nothing about what to draw.
 */
export type BootstrapStatus =
  | { phase: "working"; message: string }
  | { ok: true; message: string; notice?: string }
  | { ok: false; message: string };

export interface SavedFolder {
  /** The host folder this Project saves into — shown even when nothing is there yet. */
  dir: string;
  /** False when the Project has never been saved, so there is nothing to open. */
  opened: boolean;
  /** Epoch ms of the last save, absent if never saved. */
  lastSaved?: number;
}

export const IPC = {
  listProjects: "projects:list",
  createProject: "projects:create",
  openSession: "session:open",
  upload: "upload:pick",
  openPreview: "preview:open",
  listExportFiles: "export:list",
  saveToComputer: "export:save",
  showSavedFiles: "export:show",
  planImport: "import:plan",
  importFolder: "import:folder",
  githubStatus: "github:status",
  startGithubLogin: "github:login-start",
  awaitGithubLogin: "github:login-await",
  disconnectGithub: "github:disconnect",
  saveToGithub: "github:save",
  updateBox: "box:update",
  planDelete: "delete:plan",
  deleteProject: "delete:project",
  bootstrap: "app:bootstrap",
} as const;

declare global {
  interface Window {
    claudebox: ClaudeboxApi;
  }
}
