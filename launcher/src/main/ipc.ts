import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { statSync } from "node:fs";
import { confirmsProjectName, type DeleteListing } from "../core/delete";
import { IPC, type SavedFolder } from "../shared/api";
import {
  awaitGithubLogin,
  disconnectGithub,
  githubStatus,
  saveToGithub,
  startGithubLogin,
} from "./github";
import { exportRoot, hostBoxDefinitionDir } from "./paths";
import { detectPreviewUrl } from "./preview";
import { refreshOnLaunch } from "./refresh-runner";
import { updateMessage } from "../core/refresh";
import {
  ensureBoxReady,
  ensureEngine,
  openProjectSession,
  removeBoxContainer,
  updateClaudeCode,
} from "./session";
import {
  boxCreateProject,
  boxDeleteProject,
  boxExport,
  boxExportDir,
  boxExportListing,
  boxFindProject,
  boxImportFolder,
  boxListProjects,
  boxPlanImport,
  boxProjectUsage,
  boxUpload,
} from "./workspace";

/**
 * Wire the renderer's requests to the trusted operations. This is the ONLY
 * place the home screen's intents become real Docker/filesystem effects.
 */
export function registerIpc(window: BrowserWindow): void {
  ipcMain.handle(IPC.listProjects, () => boxListProjects());

  ipcMain.handle(IPC.createProject, (_e, name: string) => boxCreateProject(name));

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
  ipcMain.handle(IPC.saveToComputer, async (_e, slug: string, pick: string[]) => {
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

  // Project Import (ticket 09). The Box must be up for the free-space check
  // (`df`) that both the sheet and the actual copy rely on.
  ipcMain.handle(IPC.planImport, async () => {
    const picked = await dialog.showOpenDialog(window, {
      title: "Open a folder from your computer",
      properties: ["openDirectory"],
    });
    if (picked.canceled || picked.filePaths.length === 0) return undefined;
    await ensureBoxReady(hostBoxDefinitionDir());
    return boxPlanImport(picked.filePaths[0]!);
  });

  // The folder path comes from the sheet the plan above produced, but the
  // copy re-measures it rather than trusting those numbers back.
  ipcMain.handle(IPC.importFolder, async (_e, folder: string) => {
    await ensureBoxReady(hostBoxDefinitionDir());
    return boxImportFolder(folder);
  });

  // Save to GitHub (ADR 0006). The three sign-in handlers are pure host work —
  // no Box involved, and no token crosses back to the renderer.
  ipcMain.handle(IPC.githubStatus, () => githubStatus());
  ipcMain.handle(IPC.startGithubLogin, () => startGithubLogin());
  ipcMain.handle(IPC.awaitGithubLogin, () => awaitGithubLogin());
  ipcMain.handle(IPC.disconnectGithub, () => (disconnectGithub(), githubStatus()));

  // Publishing runs two ephemeral containers off the Box image, so the image has
  // to exist — the same reason Export brings the Box up first.
  ipcMain.handle(IPC.saveToGithub, async (_e, slug: string) => {
    await ensureBoxReady(hostBoxDefinitionDir());
    return saveToGithub(slug);
  });

  // Update Claudebox (ADR 0002): Refresh on Launch, on a button. Same pull of the
  // public definition, same integrity gate, same conditional build — what this
  // adds is the recreate, because a rebuilt image does nothing while the old
  // container is still the one running (the same two lines bootstrap does).
  //
  // That recreate ends every open Claude session, so it is confirmed first. The
  // pull hasn't happened yet at that point, so the question is honestly
  // conditional: there may turn out to be nothing new, and then nothing restarts.
  // Undefined on cancel — the renderer says nothing rather than reporting a
  // check that never ran (as `planImport` does for a cancelled picker).
  ipcMain.handle(IPC.updateBox, async (): Promise<string | undefined> => {
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      buttons: ["Update Claudebox", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "Update Claudebox?",
      detail:
        "If there's a new version, the sandbox restarts and any open Claude session closes. " +
        "Your projects are saved.",
    });
    if (response !== 0) return undefined;

    await ensureEngine(); // the build needs the Engine, exactly as at launch
    const result = await refreshOnLaunch();
    if (result.action !== "rebuilt") return updateMessage(result);

    await removeBoxContainer();
    await ensureBoxReady(hostBoxDefinitionDir());
    // A recreate drops back to the Claude Code baked into the image, which the
    // Dockerfile's cached npm layer can leave months old — so without this an
    // "update" could hand back an older Claude than the one just running.
    if (!(await updateClaudeCode())) {
      console.warn("Claude Code update skipped; keeping the version baked into the Box image.");
    }
    return updateMessage(result);
  });

  // Delete Project. The Box must be up to measure the Project, and the sheet
  // this feeds is the last thing standing between a click and permanent loss —
  // so it reports the Exported copies that will SURVIVE as well as what won't.
  ipcMain.handle(IPC.planDelete, async (_e, slug: string): Promise<DeleteListing> => {
    await ensureBoxReady(hostBoxDefinitionDir());
    const { project } = await boxFindProject(slug);
    const [usage, exportDir] = await Promise.all([
      boxProjectUsage(slug),
      boxExportDir(slug, exportRoot()),
    ]);
    const saved = statSync(exportDir, { throwIfNoEntry: false });

    return {
      slug,
      name: project.name,
      ...usage, // absent when the probe failed — the sheet says so rather than showing "0 files"
      exportDir,
      ...(saved ? { lastSaved: saved.mtimeMs } : {}),
    };
  });

  // The typed name arrives from the renderer, so it is input rather than truth:
  // it is re-checked here against the Project's real name inside the Box before
  // anything is removed, exactly as `saveToComputer` re-validates its selection.
  // A renderer bug (or a stale sheet naming a Project that has since been
  // renamed) must not be able to delete the wrong thing.
  ipcMain.handle(IPC.deleteProject, async (_e, slug: string, typed: string) => {
    await ensureBoxReady(hostBoxDefinitionDir());
    const { project } = await boxFindProject(slug);
    if (!confirmsProjectName(typed ?? "", project.name)) {
      throw new Error(`That isn't the name of this project, so nothing was deleted.`);
    }
    return boxDeleteProject(slug);
  });
}
