import { contextBridge, ipcRenderer } from "electron";
import type { ClaudeboxApi } from "./shared/api";
import { IPC } from "./shared/api";

/**
 * The preload bridge. Exposes ONLY the typed ClaudeboxApi to the renderer —
 * with context isolation on, the home screen gets no direct access to Node,
 * Electron, or the shell.
 */
const api: ClaudeboxApi = {
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  createProject: (name) => ipcRenderer.invoke(IPC.createProject, name),
  openSession: (slug) => ipcRenderer.invoke(IPC.openSession, slug),
  upload: (slug) => ipcRenderer.invoke(IPC.upload, slug),
  openPreview: () => ipcRenderer.invoke(IPC.openPreview),
  listExportFiles: (slug) => ipcRenderer.invoke(IPC.listExportFiles, slug),
  saveToComputer: (slug, pick) => ipcRenderer.invoke(IPC.saveToComputer, slug, pick),
  showSavedFiles: (slug) => ipcRenderer.invoke(IPC.showSavedFiles, slug),
  planImport: () => ipcRenderer.invoke(IPC.planImport),
  importFolder: (folder) => ipcRenderer.invoke(IPC.importFolder, folder),
  planDelete: (slug) => ipcRenderer.invoke(IPC.planDelete, slug),
  deleteProject: (slug, typed) => ipcRenderer.invoke(IPC.deleteProject, slug, typed),
  onBootstrap: (listener) =>
    ipcRenderer.on(IPC.bootstrap, (_e, result) => listener(result)),
};

contextBridge.exposeInMainWorld("claudebox", api);
