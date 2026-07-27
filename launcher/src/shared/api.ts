import type { ExportListing, ExportResult } from "../core/export";
import type { ImportListing } from "../core/import";
import type { Project } from "../core/projects";
import type { StarterTemplate } from "../core/templates";
import type { UploadTarget } from "../core/upload";

/**
 * The contract between the trusted main process and the renderer. Everything
 * the home screen can do goes through this narrow, typed surface — the renderer
 * never touches Docker, the filesystem, or child processes directly.
 */
export interface ClaudeboxApi {
  listProjects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  listTemplates(): Promise<StarterTemplate[]>;
  createFromTemplate(templateId: string, name?: string): Promise<Project>;
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
   * Resolves once the Engine + Box are up so the home screen can safely query
   * Projects. Rejects (with a message to show) if bootstrap failed.
   */
  onBootstrap(listener: (result: BootstrapStatus) => void): void;
}

export interface BootstrapStatus {
  ok: boolean;
  message: string;
}

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
  listTemplates: "templates:list",
  createFromTemplate: "templates:create",
  openSession: "session:open",
  upload: "upload:pick",
  openPreview: "preview:open",
  listExportFiles: "export:list",
  saveToComputer: "export:save",
  showSavedFiles: "export:show",
  planImport: "import:plan",
  importFolder: "import:folder",
  bootstrap: "app:bootstrap",
} as const;

declare global {
  interface Window {
    claudebox: ClaudeboxApi;
  }
}
