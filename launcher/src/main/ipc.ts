import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { statSync } from "node:fs";
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
import { updateClaudebox } from "./refresh-runner";
import { ensureBoxReady, openProjectSession } from "./session";
import {
  boxCreateProject,
  boxDeleteListing,
  boxDeleteProject,
  boxExport,
  boxExportDir,
  boxExportListing,
  boxImportFolder,
  boxListProjects,
  boxPlanImport,
  boxUpload,
} from "./workspace";

/**
 * The router. This is the ONLY place the home screen's intents become real
 * Docker/filesystem effects, and it does nothing but name them: every channel
 * declares a POLICY and a TARGET, and the target lives in a module that can be
 * tested without Electron. The only work left in here is the native dialogs,
 * which are the one thing the renderer genuinely cannot reach past this line.
 *
 * Two policies, and every channel picks one:
 *
 *   route       — host-only work. The Box is not involved.
 *   routeViaBox — the target touches the Workspace, so the Box is brought up
 *                 FIRST. This used to be ten remembered `ensureBoxReady` calls
 *                 with ten justifying comments, which is a rule you can forget:
 *                 a handler that did fell over as a raw `docker exec` error in
 *                 a Sandbox User's face. Declared once, it cannot be forgotten.
 *
 * A target's parameters are pinned by the arrow that calls it, never spread
 * straight from the renderer's argv — an operation whose last argument is an
 * injected `BoxExec` must not be reachable by sending a third argument.
 */
type Target<A extends unknown[]> = (...args: A) => unknown;

function route<A extends unknown[]>(channel: string, target: Target<A>): void {
  ipcMain.handle(channel, (_event, ...args) => target(...(args as A)));
}

function routeViaBox<A extends unknown[]>(channel: string, target: Target<A>): void {
  route(channel, async (...args: A) => {
    await ensureBoxReady(hostBoxDefinitionDir());
    return target(...args);
  });
}

export function registerIpc(window: BrowserWindow): void {
  /* The native affordances, which need the window. Everything else is a name. */
  const pickFiles = async (): Promise<string[]> => {
    const picked = await dialog.showOpenDialog(window, {
      title: "Upload files into this Project",
      properties: ["openFile", "multiSelections"],
    });
    return picked.canceled ? [] : picked.filePaths;
  };

  const pickFolder = async (): Promise<string | undefined> => {
    const picked = await dialog.showOpenDialog(window, {
      title: "Open a folder from your computer",
      properties: ["openDirectory"],
    });
    return picked.canceled ? undefined : picked.filePaths[0];
  };

  // The recreate ends every open Claude session, so it is confirmed first. The
  // pull hasn't happened yet at that point, so the question is honestly
  // conditional: there may turn out to be nothing new, and then nothing restarts.
  const confirmUpdate = async (): Promise<boolean> => {
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
    return response === 0;
  };

  /* Host-only channels. -------------------------------------------------- */

  // Save to GitHub (ADR 0006): the sign-in half is pure host work — no Box
  // involved, and no token crosses back to the renderer.
  route(IPC.githubStatus, () => githubStatus());
  route(IPC.startGithubLogin, () => startGithubLogin());
  route(IPC.awaitGithubLogin, () => awaitGithubLogin());
  route(IPC.disconnectGithub, () => (disconnectGithub(), githubStatus()));

  route(IPC.openPreview, async () => {
    const url = await detectPreviewUrl();
    if (!url) return { opened: false };
    await shell.openExternal(url);
    return { opened: true, url };
  });

  // Update Claudebox brings the Box up itself, mid-sequence and after the
  // rebuild — so it declares no policy here. Undefined on cancel: the renderer
  // says nothing rather than reporting a check that never ran.
  route(IPC.updateBox, async (): Promise<string | undefined> =>
    (await confirmUpdate()) ? updateClaudebox() : undefined,
  );

  /* Workspace channels — the Box is up before any of these run. ----------- */

  routeViaBox(IPC.listProjects, () => boxListProjects());
  routeViaBox(IPC.createProject, (name: string) => boxCreateProject(name));
  routeViaBox(IPC.openSession, (slug: string) => openProjectSession(slug));

  routeViaBox(IPC.upload, async (slug: string) => {
    const files = await pickFiles();
    return files.length === 0 ? [] : boxUpload(files, slug);
  });

  routeViaBox(IPC.listExportFiles, (slug: string) => boxExportListing(slug, exportRoot()));

  // `pick` comes from the renderer, so it is input rather than truth: boxExport
  // re-enumerates the Project inside the Box and re-runs the allowlist over every
  // ticked path before a byte is copied.
  routeViaBox(IPC.saveToComputer, (slug: string, pick: string[]) =>
    boxExport(slug, exportRoot(), pick),
  );

  // Needs the Box for the landing folder's name, which lives in metadata inside it.
  routeViaBox(IPC.showSavedFiles, async (slug: string): Promise<SavedFolder> => {
    const dir = await boxExportDir(slug, exportRoot());
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (!stat) return { dir, opened: false }; // never saved — nothing to show yet
    await shell.openPath(dir);
    // ponytail: "last saved" is the folder's mtime, which Finder also bumps when
    // it drops a .DS_Store in. Write a stamp file if the drift ever matters.
    return { dir, opened: true, lastSaved: stat.mtimeMs };
  });

  routeViaBox(IPC.planImport, async () => {
    const folder = await pickFolder();
    return folder === undefined ? undefined : boxPlanImport(folder);
  });

  // The folder path comes from the sheet the plan above produced, but the
  // copy re-measures it rather than trusting those numbers back.
  routeViaBox(IPC.importFolder, (folder: string) => boxImportFolder(folder));

  // Publishing runs two ephemeral containers off the Box image, so the image has
  // to exist — the same reason Export brings the Box up first.
  routeViaBox(IPC.saveToGithub, (slug: string) => saveToGithub(slug));

  routeViaBox(IPC.planDelete, (slug: string) => boxDeleteListing(slug, exportRoot()));
  routeViaBox(IPC.deleteProject, (slug: string, typed: string) => boxDeleteProject(slug, typed));
}
