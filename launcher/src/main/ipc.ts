import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { statSync } from "node:fs";
import { STARTER_TEMPLATES, templateById } from "../core/templates";
import { IPC, type SavedFolder } from "../shared/api";
import { exportRoot, hostBoxDefinitionDir } from "./paths";
import { detectPreviewUrl } from "./preview";
import { ensureBoxReady, openProjectSession } from "./session";
import {
  boxCreateProject,
  boxExport,
  boxExportDir,
  boxExportListing,
  boxListProjects,
  boxUpload,
} from "./workspace";

/**
 * Wire the renderer's requests to the trusted operations. This is the ONLY
 * place the home screen's intents become real Docker/filesystem effects.
 */
export function registerIpc(window: BrowserWindow): void {
  ipcMain.handle(IPC.listProjects, () => boxListProjects());

  ipcMain.handle(IPC.createProject, (_e, name: string) => boxCreateProject(name));

  ipcMain.handle(IPC.listTemplates, () => STARTER_TEMPLATES);

  ipcMain.handle(IPC.createFromTemplate, async (_e, templateId: string, name?: string) => {
    const template = templateById(templateId);
    if (!template) throw new Error(`Unknown Starter Template: '${templateId}'.`);
    return boxCreateProject(name ?? template.defaultProjectName, template.seedPrompt);
  });

  ipcMain.handle(IPC.openSession, async (_e, slug: string) => {
    await ensureBoxReady(hostBoxDefinitionDir());
    await openProjectSession(slug);
  });

  ipcMain.handle(IPC.upload, async (_e, slug: string) => {
    const picked = await dialog.showOpenDialog(window, {
      title: "Upload files into this Project",
      properties: ["openFile", "multiSelections"],
    });
    if (picked.canceled || picked.filePaths.length === 0) return [];
    return boxUpload(picked.filePaths, slug);
  });

  ipcMain.handle(IPC.openPreview, async () => {
    const url = await detectPreviewUrl();
    if (!url) return { opened: false };
    await shell.openExternal(url);
    return { opened: true, url };
  });

  // Export. The Box must be up to be read from, so bring it up first rather than
  // failing at the `docker exec` with something a Sandbox User can't act on.
  ipcMain.handle(IPC.listExportFiles, async (_e, slug: string) => {
    await ensureBoxReady(hostBoxDefinitionDir());
    return boxExportListing(slug, exportRoot());
  });

  // `pick` comes from the renderer, so it is input rather than truth: boxExport
  // re-enumerates the Project inside the Box and re-runs the allowlist over every
  // ticked path before a byte is copied.
  ipcMain.handle(IPC.saveToMac, async (_e, slug: string, pick: string[]) => {
    await ensureBoxReady(hostBoxDefinitionDir());
    return boxExport(slug, exportRoot(), pick);
  });

  // Also needs the Box: the landing folder is named after the Project's friendly
  // name, which lives in metadata inside it.
  ipcMain.handle(IPC.showSavedFiles, async (_e, slug: string): Promise<SavedFolder> => {
    await ensureBoxReady(hostBoxDefinitionDir());
    const dir = await boxExportDir(slug, exportRoot());
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (!stat) return { dir, opened: false }; // never saved — nothing to show yet
    await shell.openPath(dir);
    // ponytail: "last saved" is the folder's mtime, which Finder also bumps when
    // it drops a .DS_Store in. Write a stamp file if the drift ever matters.
    return { dir, opened: true, lastSaved: stat.mtimeMs };
  });
}
