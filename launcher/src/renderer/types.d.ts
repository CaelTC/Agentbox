/**
 * xterm.js is bundled with the packaged Launcher and exposed as the global
 * `Terminal`. Typed loosely here — the renderer only uses a small slice.
 */
interface XtermTerminal {
  open(el: HTMLElement): void;
  write(data: string): void;
  onData(cb: (data: string) => void): void;
}

interface Window {
  Terminal: new (opts?: Record<string, unknown>) => XtermTerminal;
}
