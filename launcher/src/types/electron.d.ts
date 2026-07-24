/**
 * Minimal ambient declaration of the Electron API surface the Launcher uses.
 *
 * WHY THIS EXISTS: Claudebox targets macOS, but this repo is developed and
 * type-checked in a Linux CI box where installing the ~100MB Electron binary is
 * neither necessary nor desirable. This shim lets the main-process code
 * type-check against the exact surface we depend on. At runtime the real
 * `electron` package provides these — it is a genuine dependency of the built
 * Launcher app (declared in the app's own package.json when packaged for macOS).
 */
declare module "electron" {
  export interface IpcMainInvokeEvent {
    readonly sender: unknown;
  }

  export interface IpcMain {
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
    ): void;
  }

  export interface WebContents {
    send(channel: string, ...args: any[]): void;
    once(event: string, listener: (...args: any[]) => void): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }

  export interface BrowserWindow {
    loadFile(path: string): Promise<void>;
    readonly webContents: WebContents;
    show(): void;
  }

  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    title?: string;
    webPreferences?: { preload?: string; contextIsolation?: boolean };
  }

  export const BrowserWindow: {
    new (options?: BrowserWindowConstructorOptions): BrowserWindow;
    getAllWindows(): BrowserWindow[];
  };

  export interface OpenDialogOptions {
    title?: string;
    properties?: Array<"openFile" | "multiSelections">;
  }
  export interface OpenDialogReturnValue {
    canceled: boolean;
    filePaths: string[];
  }
  export const dialog: {
    showOpenDialog(
      window: BrowserWindow,
      options: OpenDialogOptions,
    ): Promise<OpenDialogReturnValue>;
  };

  export const shell: {
    openExternal(url: string): Promise<void>;
  };

  export const ipcMain: IpcMain;

  export interface App {
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): void;
    quit(): void;
  }
  export const app: App;

  export const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };
  export const ipcRenderer: {
    invoke(channel: string, ...args: any[]): Promise<any>;
    on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  };
}
