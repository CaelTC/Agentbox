import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { STARTER_TEMPLATES, templateById } from "../core/templates";
import { IPC } from "../shared/api";
import { hostBoxDefinitionDir } from "./paths";
import { detectPreviewUrl } from "./preview";
import { ensureBoxReady, sessionCommand } from "./session";
import { SessionHost } from "./terminal";
import {
  boxCreateProject,
  boxListProjects,
  boxProjectSeedPrompt,
  boxUpload,
} from "./workspace";

/**
 * Wire the renderer's requests to the trusted operations. This is the ONLY
 * place the home screen's intents become real Docker/filesystem effects.
 */
export function registerIpc(window: BrowserWindow): void {
  const session = new SessionHost(window.webContents);

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
    const seedPrompt = await boxProjectSeedPrompt(slug);
    const { command, args } = sessionCommand(`/workspace/${slug}`, seedPrompt);
    session.open(command, args);
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

  // Keystrokes from the renderer's terminal → the pty.
  ipcMain.handle(IPC.sessionInput, (_e, data: string) => {
    session.write(data);
  });
}
