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
  listTemplates: () => ipcRenderer.invoke(IPC.listTemplates),
  createFromTemplate: (templateId, name) =>
    ipcRenderer.invoke(IPC.createFromTemplate, templateId, name),
  openSession: (slug) => ipcRenderer.invoke(IPC.openSession, slug),
  upload: (slug) => ipcRenderer.invoke(IPC.upload, slug),
  openPreview: () => ipcRenderer.invoke(IPC.openPreview),
  onBootstrap: (listener) =>
    ipcRenderer.on(IPC.bootstrap, (_e, result) => listener(result)),
};

contextBridge.exposeInMainWorld("claudebox", api);
