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
  claudebox: import("../shared/api").ClaudeboxApi;
}

// Global type aliases (inline import() keeps this a global .d.ts, no top-level
// import) so app.ts needs no `import` — which lets tsc emit it as a plain
// classic script instead of a CommonJS module the browser can't run.
type Project = import("../core/projects").Project;
type StarterTemplate = import("../core/templates").StarterTemplate;
