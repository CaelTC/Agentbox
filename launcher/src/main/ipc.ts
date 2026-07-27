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
import { exclusive } from "./gate";
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
 *                 FIRST and the operation runs alone (the Box Gate). This used
 *                 to be ten remembered `ensureBoxReady` calls with ten
 *                 justifying comments, which is a rule you can forget: a
 *                 handler that did fell over as a raw `docker exec` error in a
 *                 Sandbox User's face. Declared once, it cannot be forgotten —
 *                 and the same is now true of the exclusion, which no caller
 *                 can remember to take either.
 *
 * The two channels below that reach the Box WITHOUT this policy — Update
 * Claudebox, which brings the Box up itself, and Web Preview, which only reads
 * a Box that is already up — take the gate by hand, and say why at the call.
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
  route(channel, (...args: A) =>
    // The native pickers inside two of these targets run while the gate is
    // held. That costs nothing: they are window-modal, so the Sandbox User
    // cannot start a second operation while one is open anyway.
    exclusive(async () => {
      await ensureBoxReady(hostBoxDefinitionDir());
      return target(...args);
    }),
  );
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
  // involved, and no token crosses back to the renderer. Ungated for the same
  // reason: `awaitGithubLogin` polls GitHub for as long as the device code
  // lives, and a gate held for those minutes would freeze the whole Launcher
  // behind a sign-in the Sandbox User may have wandered off from.
  route(IPC.githubStatus, () => githubStatus());
  route(IPC.startGithubLogin, () => startGithubLogin());
  route(IPC.awaitGithubLogin, () => awaitGithubLogin());
  route(IPC.disconnectGithub, () => (disconnectGithub(), githubStatus()));

  // Reads the listening ports of a Box that is already up, so it declares no
  // Box policy — but it does reach inside the running container, and an Update
  // recreating that container underneath it would report "no preview" for a
  // server that is simply mid-restart. Gated, not brought up.
  route(IPC.openPreview, () =>
    exclusive(async () => {
      const url = await detectPreviewUrl();
      if (!url) return { opened: false };
      await shell.openExternal(url);
      return { opened: true, url };
    }),
  );

  // Update Claudebox brings the Box up itself, mid-sequence and after the
  // rebuild — so it declares no policy here. Undefined on cancel: the renderer
  // says nothing rather than reporting a check that never ran.
  //
  // The confirmation is deliberately OUTSIDE the gate and the recreate inside
  // it: a modal question is not an operation, and holding the Box hostage while
  // it sits open would stall an Upload that was already running for a dialog
  // the Sandbox User may yet cancel. Once they say yes, this is the operation
  // every other one has to wait for — it is the one that removes the container.
  route(IPC.updateBox, async (): Promise<string | undefined> =>
    (await confirmUpdate()) ? exclusive(() => updateClaudebox()) : undefined,
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
