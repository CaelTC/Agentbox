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
   * Bring the Box up, ensure the Project's session via the funnel, and open it
   * in a Chrome app-mode window. Also serves "Reopen terminal" (re-attaches the
   * live session).
   */
  openSession(slug: string): Promise<void>;
  /** Open a native file picker and copy the chosen files into the Project. */
  upload(slug: string): Promise<UploadTarget[]>;
  /** Detect the served port and open it in the Mac's browser. */
  openPreview(): Promise<{ opened: boolean; url?: string }>;

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

export const IPC = {
  listProjects: "projects:list",
  createProject: "projects:create",
  listTemplates: "templates:list",
  createFromTemplate: "templates:create",
  openSession: "session:open",
  upload: "upload:pick",
  openPreview: "preview:open",
  bootstrap: "app:bootstrap",
} as const;

declare global {
  interface Window {
    claudebox: ClaudeboxApi;
  }
}
