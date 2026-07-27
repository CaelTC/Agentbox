import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

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
const src = (...parts: string[]) => readFileSync(join(__dirname, "..", "src", ...parts), "utf8");
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
  const build = new Function("document", "setTimeout", `${js}\nreturn { el, flash, openSheet, runOperation };`);
  return { document, ...build(document, () => undefined) } as {
    document: ReturnType<typeof fakeDocument>;
    el: (tag: string, props?: Record<string, unknown>, children?: unknown[]) => any;
    flash: (message: string) => void;
    openSheet: (title: string, contents: unknown[], actions: unknown[]) => () => void;
    runOperation: (op: Record<string, unknown>) => Promise<void>;
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
      run: () => Promise.reject(new Error("Error: No such container: claudebox")),
      done: () => expect.unreachable("done() ran for a failed operation"),
      failed: "Couldn't save",
    });

    expect(sheets(document)).toHaveLength(0);
    expect(flashes(document)).toEqual(["Couldn't save: Error: No such container: claudebox"]);
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
    expect(updateBtn.disabled).toBeUndefined(); // and its button was left alone
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
