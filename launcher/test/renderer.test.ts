import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { repoFile } from "./repo-file";

/**
 * The renderer is a classic <script>: `src/renderer/app.ts` has no imports and
 * no exports, because tsc would emit CommonJS and the browser would throw on the
 * first `require`. So this file reaches for app.ts as a *source file* rather than
 * a module, two ways:
 *
 *  - the machinery region (openSheet, runOperation, flash, el) is cut out,
 *    compiled, and run against a fake DOM — that region is written to depend on
 *    nothing but `document` and `setTimeout` precisely so this can work;
 *  - the two functions app.ts is forced to keep a second copy of (`normalize`
 *    from core/delete.ts, `size` from core/format.ts) are compared as text
 *    against their originals, the same trick test/preview.test.ts plays on
 *    box/entrypoint.sh.
 */
const src = (...parts: string[]) => repoFile("launcher", "src", ...parts);
const APP = src("renderer", "app.ts");

// --- the machinery, cut out and run ------------------------------------------

const REGION = /\/\/ --- the renderer's machinery -[\s\S]*?\n\/\/ --- end of the renderer's machinery/;

/** A DOM small enough to hold a sheet: append, remove, and arbitrary properties. */
function fakeDocument() {
  const create = (tag: string): any => {
    const node: any = {
      tag,
      children: [] as any[],
      parent: undefined as any,
      append(...kids: any[]) {
        for (const kid of kids) {
          if (kid && typeof kid === "object") kid.parent = node;
          node.children.push(kid);
        }
      },
      remove() {
        const at = node.parent?.children.indexOf(node) ?? -1;
        if (at >= 0) node.parent.children.splice(at, 1);
        node.parent = undefined;
      },
    };
    return node;
  };
  return { createElement: create, body: create("body") };
}

/** A fresh renderer: its own DOM, and its own busy state. */
function renderer() {
  const region = APP.match(REGION);
  expect(region, "the machinery markers in app.ts are gone — see this file's docstring").not.toBeNull();
  const js = transformSync(region![0], { loader: "ts" }).code;
  const document = fakeDocument();
  // A `setTimeout` that never fires, so a flash stays put to be asserted on.
  const build = new Function(
    "document",
    "setTimeout",
    `${js}\nreturn { el, fail, flash, openSheet, runOperation, fileFolders, inFolder, matchesFilter, selectionTotal };`,
  );
  return { document, ...build(document, () => undefined) } as {
    document: ReturnType<typeof fakeDocument>;
    el: (tag: string, props?: Record<string, unknown>, children?: unknown[]) => any;
    fail: (prefix: string, err: unknown) => string;
    flash: (message: string) => void;
    openSheet: (title: string, contents: unknown[], actions: unknown[]) => () => void;
    runOperation: (op: Record<string, unknown>) => Promise<void>;
    fileFolders: (paths: readonly string[]) => string[];
    inFolder: (path: string, folder: string) => boolean;
    matchesFilter: (path: string, query: string) => boolean;
    selectionTotal: (
      files: readonly { path: string; size: number }[],
      selected: ReadonlySet<string>,
      capBytes: number,
    ) => { count: number; bytes: number; over: boolean };
  };
}

const flashes = (document: ReturnType<typeof fakeDocument>) =>
  document.body.children.filter((c: any) => c.className === "flash").map((c: any) => c.textContent);

const sheets = (document: ReturnType<typeof fakeDocument>) =>
  document.body.children.filter((c: any) => c.className === "sheet");

describe("openSheet", () => {
  it("builds the one sheet shape: backdrop, panel, title, contents, actions last", () => {
    const { document, el, openSheet } = renderer();
    const cancel = el("button", { textContent: "Cancel" });
    const confirm = el("button", { textContent: "Delete forever" });
    const body = el("p", { textContent: "This can't be undone." });

    openSheet("Delete this project", [body], [cancel, confirm]);

    expect(sheets(document)).toHaveLength(1);
    const panel = sheets(document)[0].children[0];
    expect(panel.className).toBe("panel");
    expect(panel.children.map((c: any) => c.tag)).toEqual(["h2", "p", "div"]);
    expect(panel.children[0].textContent).toBe("Delete this project");
    expect(panel.children[1]).toBe(body);
    const actions = panel.children[2];
    expect(actions.className).toBe("actions");
    // Cancel first, the committing button last — the order the caller passed.
    expect(actions.children).toEqual([cancel, confirm]);
  });

  it("hands back a close() that takes its own sheet and no one else's", () => {
    const { document, openSheet } = renderer();
    const closeFirst = openSheet("Bring in a project", [], []);
    openSheet("Connect GitHub", [], []);

    closeFirst();
    expect(sheets(document)).toHaveLength(1);

    // Both outcomes of an operation close the sheet, and the GitHub sheet closes
    // itself in a callback that may already have been cancelled: closing twice
    // has to be harmless, not eat the sheet that opened after it.
    closeFirst();
    expect(sheets(document)).toHaveLength(1);
  });
});

describe("runOperation", () => {
  const pending = <T>() => {
    let settle!: { ok: (value: T) => void; fail: (err: Error) => void };
    const promise = new Promise<T>((res, rej) => (settle = { ok: res, fail: rej }));
    return { promise, ...settle };
  };

  it("disables the button, says what it is doing, and hands it back afterwards", async () => {
    const { el, runOperation } = renderer();
    const button = el("button", { textContent: "Update Claudebox" });
    const work = pending<string>();

    const running = runOperation({
      button,
      busyLabel: "Checking…",
      run: () => work.promise,
      done: () => undefined,
      failed: "Couldn't update Claudebox",
    });

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Checking…");

    work.ok("Claudebox is up to date.");
    await running;

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Update Claudebox");
  });

  it("closes the sheet before done() re-renders the screen behind it", async () => {
    const { document, el, openSheet, runOperation } = renderer();
    const button = el("button", { textContent: "Delete forever" });
    const close = openSheet("Delete this project", [], [button]);
    const seen: number[] = [];

    await runOperation({
      button,
      busyLabel: "Deleting…",
      close,
      run: () => Promise.resolve("deleted"),
      done: () => seen.push(sheets(document).length),
      failed: "Couldn't delete My website",
    });

    expect(seen).toEqual([0]); // the sheet was already gone when done() ran
    // A sheet takes its button with it, so nothing is handed back.
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Deleting…");
  });

  it("puts the reason behind one prefix, and closes the sheet either way", async () => {
    const { document, el, openSheet, runOperation } = renderer();
    const button = el("button", { textContent: "Save" });
    const close = openSheet("Save to my computer", [], [button]);

    await runOperation({
      button,
      busyLabel: "Saving…",
      close,
      // The shape a rejection ACTUALLY has by the time it reaches here: Electron
      // wraps everything thrown in a handler on its way back across the bridge.
      run: () =>
        Promise.reject(
          new Error("Error invoking remote method 'export:save': Error: No such container: claudebox"),
        ),
      done: () => expect.unreachable("done() ran for a failed operation"),
      failed: "Couldn't save",
    });

    expect(sheets(document)).toHaveLength(0);
    expect(flashes(document)).toEqual(["Couldn't save: No such container: claudebox"]);
  });

  /**
   * A `done` that throws is a SUCCEEDED operation whose screen couldn't catch
   * up. Reported as the operation failing, it told the Sandbox User "Couldn't
   * delete My website" about a delete that had already happened, and left them
   * on the panel of a Project that no longer exists.
   */
  it("says something different when the operation worked and only the refresh didn't", async () => {
    const { document, el, runOperation } = renderer();
    const button = el("button", { textContent: "Delete forever" });
    let closes = 0;

    await runOperation({
      button,
      busyLabel: "Deleting…",
      close: () => closes++,
      run: () => Promise.resolve("deleted"),
      done: () => Promise.reject(new Error("the Box stopped answering")),
      failed: "Couldn't delete My website",
    });

    expect(closes).toBe(1); // the success path closed the sheet, once
    expect(flashes(document)).toEqual(["Done, but the screen couldn't refresh: the Box stopped answering"]);
  });

  // What follows a finished operation is a screen, and the screens start
  // operations of their own — a finished Import opens the new Project's session.
  // Holding the busy state across `done` refused the click `done` had just made.
  it("has let go of the busy state by the time done() runs", async () => {
    const { el, runOperation } = renderer();
    const button = el("button", { textContent: "Bring it in" });
    let opened = 0;

    await runOperation({
      button,
      busyLabel: "Bringing it in…",
      run: () => Promise.resolve("imported"),
      done: () =>
        runOperation({
          button: el("button", { textContent: "Reopen session" }),
          busyLabel: "Opening…",
          run: () => Promise.resolve((opened += 1)),
          done: () => undefined,
          failed: "Couldn't open the Claude session",
        }),
      failed: "Couldn't bring that in",
    });

    expect(opened).toBe(1);
  });

  // The action cards are a title and a description, not one string: replacing
  // their text to say "Uploading…" would flatten the card into a text node, so
  // they go grey instead and say the rest in a flash when they land.
  it("disables a card without a busy label, and leaves its contents alone", async () => {
    const { document, el, runOperation } = renderer();
    const card = el("button", { className: "card" }, [el("strong", { textContent: "Upload files" })]);
    const work = pending<string[]>();

    const running = runOperation({
      button: card,
      run: () => work.promise,
      done: () => undefined,
      failed: "Couldn't upload those files",
    });

    expect(card.disabled).toBe(true);
    expect(card.children).toHaveLength(1); // still a card, not a label

    work.fail(new Error("Error invoking remote method 'upload:pick': Error: no space left on device"));
    await running;

    // A failed Upload used to be completely silent: no catch, no flash, and a
    // card that simply did nothing.
    expect(flashes(document)).toEqual(["Couldn't upload those files: no space left on device"]);
    expect(card.disabled).toBe(false);
  });

  it("runs one operation at a time, across screens", async () => {
    // The reason this exists: "Update Claudebox" recreates the container, and it
    // is a click away on the home screen while an Export is still copying out of
    // a Project. Disabling the clicked button cannot see that far.
    const { document, el, runOperation } = renderer();
    const exporting = pending<string>();
    const exportBtn = el("button", { textContent: "Save" });
    const updateBtn = el("button", { textContent: "Update Claudebox" });
    let updates = 0;

    const first = runOperation({
      button: exportBtn,
      busyLabel: "Saving…",
      run: () => exporting.promise,
      done: () => undefined,
      failed: "Couldn't save",
    });

    await runOperation({
      button: updateBtn,
      busyLabel: "Checking…",
      run: () => {
        updates += 1;
        return Promise.resolve("updated");
      },
      done: () => undefined,
      failed: "Couldn't update Claudebox",
    });

    expect(updates).toBe(0); // the Box was never touched
    expect(updateBtn.disabled).toBeFalsy(); // and its button was left alone
    expect(flashes(document)).toEqual(["Claudebox is already busy with something else. Let that finish first."]);

    exporting.ok("saved");
    await first;
  });

  it("lets go of the busy state when an operation fails", async () => {
    const { el, runOperation } = renderer();
    const button = el("button", { textContent: "Save" });
    let runs = 0;
    const op = (run: () => Promise<string>) => ({
      button,
      busyLabel: "Saving…",
      run,
      done: () => undefined,
      failed: "Couldn't save",
    });

    await runOperation(op(() => Promise.reject(new Error("the Box is gone"))));
    await runOperation(
      op(() => {
        runs += 1;
        return Promise.resolve("saved");
      }),
    );

    expect(runs).toBe(1);
  });
});

describe("fail", () => {
  // Everything the trusted layer throws crosses `ipcRenderer.invoke`, which
  // rebuilds it as `Error invoking remote method '<channel>': Error: <msg>`.
  // That is the string the Sandbox User was being shown, in front of the only
  // words in it that meant anything.
  it("strips Electron's IPC wrapper before the reason", () => {
    const { fail } = renderer();
    expect(fail("Couldn't upload those files", new Error("Error invoking remote method 'upload:pick': Error: no space left on device"))).toBe(
      "Couldn't upload those files: no space left on device",
    );
  });

  it("strips a bare Error: too, and survives something that isn't an Error at all", () => {
    const { fail } = renderer();
    expect(fail("Couldn't save", new Error("Error: No such container: claudebox"))).toBe(
      "Couldn't save: No such container: claudebox",
    );
    expect(fail("Couldn't save", "the Box is gone")).toBe("Couldn't save: the Box is gone");
  });

  it("is the only thing in app.ts that composes a failure out of an error", () => {
    // Seven hand-rolled `Couldn't …: ${(err as Error).message}` catches used to
    // sit alongside it, none of them stripping the wrapper above. A new one is
    // how the noise gets back onto the screen.
    expect(APP.match(/Couldn't[^`\n]*\$\{\(?err/g)).toBeNull();
  });
});

// --- the Files tab -----------------------------------------------------------

/**
 * The two-pane browser's whole model, which is why these four live in the
 * machinery region: the pane itself is DOM this file has no seam for, but what
 * it SHOWS is these functions, and they are the part that can quietly go wrong.
 */
describe("the Files tab's folder pane", () => {
  it("derives every folder and every folder above one, ancestors first", () => {
    const { fileFolders } = renderer();
    expect(fileFolders(["notes.md", "data/2024/costs.csv", "data/readme.txt", "src/app.ts"])).toEqual([
      "data",
      "data/2024",
      "src",
    ]);
  });

  // Lexicographic order is what makes indent-by-depth enough to draw a tree: a
  // folder that appeared before its own parent would hang off the wrong row.
  it("never lists a folder before the folder it sits in", () => {
    const { fileFolders } = renderer();
    const folders = fileFolders(["a/b/c/deep.txt", "a/other.txt", "z/last.txt"]);
    expect(folders).toEqual(["a", "a/b", "a/b/c", "z"]);
    for (const [at, folder] of folders.entries()) {
      const parent = folder.slice(0, folder.lastIndexOf("/"));
      if (parent && folder.includes("/")) expect(folders.indexOf(parent)).toBeLessThan(at);
    }
  });

  it("has no row for the Project root — that is All files, which matches everything", () => {
    const { fileFolders, inFolder } = renderer();
    expect(fileFolders(["notes.md"])).toEqual([]);
    expect(inFolder("notes.md", "")).toBe(true);
    expect(inFolder("data/2024/costs.csv", "")).toBe(true);
  });

  // A folder row holds everything UNDER it, however deep — picking "data" and
  // seeing nothing because the files are all one level further down is the bug
  // this prevents. And a prefix is not a folder: "data" must not swallow "database".
  it("holds everything under a folder, and nothing from a folder that merely starts the same", () => {
    const { inFolder } = renderer();
    expect(inFolder("data/2024/costs.csv", "data")).toBe(true);
    expect(inFolder("data/2024/costs.csv", "data/2024")).toBe(true);
    expect(inFolder("database/schema.sql", "data")).toBe(false);
    expect(inFolder("notes.md", "data")).toBe(false);
  });
});

describe("the Files tab's filter and total", () => {
  it("matches anywhere in the path, either case, ignoring what was typed around it", () => {
    const { matchesFilter } = renderer();
    expect(matchesFilter("data/2024-costs.CSV", "csv")).toBe(true);
    expect(matchesFilter("data/2024-costs.csv", "  DATA ")).toBe(true);
    expect(matchesFilter("notes.md", "csv")).toBe(false);
    expect(matchesFilter("notes.md", "")).toBe(true); // an empty field hides nothing
  });

  // The selection survives switching folders and filtering, so the total is over
  // everything ticked — not over what happens to be on screen.
  it("totals everything ticked, wherever it is, and says when it is over the cap", () => {
    const { selectionTotal } = renderer();
    const files = [
      { path: "notes.md", size: 1_000 },
      { path: "data/costs.csv", size: 2_000 },
      { path: "src/app.ts", size: 4_000 },
    ];
    expect(selectionTotal(files, new Set(["notes.md", "src/app.ts"]), 10_000)).toEqual({
      count: 2,
      bytes: 5_000,
      over: false,
    });
    expect(selectionTotal(files, new Set(files.map((f) => f.path)), 5_000).over).toBe(true);
    // Exactly at the cap is allowed: core/export.ts refuses above it, not at it.
    expect(selectionTotal(files, new Set(files.map((f) => f.path)), 7_000).over).toBe(false);
    expect(selectionTotal(files, new Set(["gone.txt"]), 10_000)).toEqual({ count: 0, bytes: 0, over: false });
  });
});

/**
 * The Box Gate is single-file and not re-entrant, so anything on a timer sits on
 * the lock the Claude session itself needs. The Files tab therefore reads ONCE
 * when it is opened and again only when the Sandbox User asks — a `setInterval`
 * added to keep it "live" is the failure this test names in advance.
 */
it("has exactly one repeating timer in the renderer, and it is the starting clock", () => {
  const intervals = APP.match(/setInterval\(/g) ?? [];
  expect(intervals).toHaveLength(1);
  expect(APP).toMatch(/startingClock = setInterval\(/);
});

// --- the two copies app.ts is forced to keep ---------------------------------

/** The source text of a top-level function, `export` prefix and all trimmed off. */
function declaration(source: string, name: string): string {
  const found = source.match(new RegExp(`function ${name}\\(([\\s\\S]*?)\\n\\}`));
  expect(found, `${name} is no longer a top-level function`).not.toBeNull();
  return found![0];
}

describe("the renderer's two copies of a core rule", () => {
  // Neither can be imported: the renderer is a classic <script> (core/format.ts
  // explains it at length). Duplication is therefore the design — drifting is
  // not, and nothing but these two tests would notice.
  it("app.ts normalizes the typed Project name exactly as core/delete.ts does", () => {
    // Drift here enables "Delete forever" on a name the trusted layer then
    // refuses, which reads to the Sandbox User as a dead button.
    expect(declaration(APP, "normalize")).toBe(declaration(src("core", "delete.ts"), "normalize"));
    expect(declaration(APP, "normalize")).toContain("replace(/\\s+/g");
  });

  it("app.ts sizes bytes exactly as core/format.ts does", () => {
    // Drift here has the confirmation sheet and the dialog behind it quoting two
    // different sizes for the same Import.
    expect(declaration(APP, "size")).toBe(declaration(src("core", "format.ts"), "size"));
    expect(declaration(APP, "size")).toContain("GB");
  });
});
