import type { WebContents } from "electron";
import { IPC } from "../shared/api";

/**
 * Hosts the interactive Claude session in a pseudo-terminal so the Sandbox User
 * sees a chat, never a terminal or Docker plumbing (ticket 04). `node-pty` is a
 * genuine runtime dependency of the packaged app; it is loaded via runtime
 * `require` purely so THIS FILE TYPE-CHECKS in the headless CI box where the
 * native module isn't installed (it is always present at runtime).
 */
interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  kill(): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): Pty;
}

export class SessionHost {
  private pty: Pty | undefined;

  constructor(private readonly webContents: WebContents) {}

  open(command: string, args: string[]): void {
    this.pty?.kill();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require("node-pty") as PtyModule;
    const pty = nodePty.spawn(command, args, {
      name: "xterm-color",
      cols: 100,
      rows: 30,
      env: process.env,
    });
    pty.onData((data) => this.webContents.send(IPC.sessionData, data));
    this.pty = pty;
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  dispose(): void {
    this.pty?.kill();
    this.pty = undefined;
  }
}
