/**
 * The renderer's bridge, its machinery, and the rules it is forced to keep a
 * second copy of. Pure DOM against the narrow `window.agentbox` bridge — no
 * Node, Docker, or shell access anywhere in `renderer/`.
 *
 * The FIRST of the renderer's classic scripts: index.html lists them in the
 * order they must run, and everything below is what the rest of them lean on.
 */
const cb = window.agentbox;

const app = () => document.getElementById("app")!;

// --- the renderer's machinery ------------------------------------------------
// Everything between this marker and its closing twin touches nothing but
// `document` and `setTimeout`. That is deliberate: the renderer is a classic
// <script> and so can neither import nor export (see core/format.ts), and
// test/renderer.test.ts extracts this region verbatim and evaluates it against a
// fake DOM. Reaching for `cb`, a screen, or a global from in here is what would
// break that test — the rest of the renderer may lean on this region, never the
// other way round.

function el(tag: string, props: Record<string, unknown> = {}, children: (Node | string)[] = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

function flash(message: string): void {
  const note = el("div", { className: "flash", textContent: message });
  document.body.append(note);
  setTimeout(() => note.remove(), 3500);
}

/**
 * The one failure sentence in the app: a prefix in the Sandbox User's terms,
 * then the reason. Every "Couldn't …" on screen is composed here, so none of
 * them can drift into a different shape.
 *
 * The stripping is the point. Electron wraps every rejection that crosses the
 * bridge, so what a handler threw arrives as `Error invoking remote method
 * 'upload:pick': Error: no space left on device` — and the inner `Error: `
 * survives the unwrapping. Neither is anything a Sandbox User can act on, and
 * both were being shown verbatim in front of the only words that helped.
 */
function fail(prefix: string, err: unknown): string {
  const reason = (err instanceof Error ? err.message : String(err))
    .replace(/^Error invoking remote method '[^']*': /, "")
    .replace(/^Error: /, "");
  return `${prefix}: ${reason}`;
}

/**
 * Every modal in Agentbox is this sheet: a backdrop, one panel, a title, the
 * caller's own contents, and a row of actions along the bottom. Four of them
 * opened with the same seven lines and closed with the same four before this
 * existed, and only the Delete sheet's `focus()` ever differed — so that stays
 * the caller's business, after the sheet is up.
 *
 * Returns the sheet's own `close`. A panel is built before it is shown, so a
 * button inside it can only be told how to dismiss it afterwards.
 */
function openSheet(title: string, contents: (Node | string)[], actions: Node[]): () => void {
  const dialog = el("div", { className: "sheet" });
  dialog.append(
    el("div", { className: "panel" }, [
      el("h2", { textContent: title }),
      ...contents,
      el("div", { className: "actions" }, actions),
    ]),
  );
  document.body.append(dialog);
  return () => dialog.remove();
}

/** A button that reaches into the Box, and what to do with either outcome. */
type Operation<T> = {
  button: HTMLButtonElement;
  /**
   * What the button says while it runs — "Saving…", "Deleting…". Omitted by the
   * action cards, whose label is a title and a description rather than one
   * string: replacing their text would flatten the card. Those go grey and say
   * the rest in a flash when they land.
   */
  busyLabel?: string;
  run: () => Promise<T>;
  done: (result: T) => void | Promise<void>;
  /** "Couldn't save" — the reason is appended, so the copy reads the same everywhere. */
  failed: string;
  /** The sheet this button lives in, if it lives in one: closed on either outcome. */
  close?: () => void;
};

/**
 * The one operation the renderer will run at a time.
 *
 * Every operation below mutates the Box, and "Update Agentbox" recreates the
 * container outright — so a second one started while the first is in flight can
 * `docker rm -f` the Box out from under it, from a screen the first one never
 * sees (Update lives on the home screen; an Export runs from inside a Project).
 * Disabling the button that was clicked cannot see that far, which is why the
 * busy state lives here and nowhere else.
 *
 * EVERY control that reaches the Box comes through here, not just the four that
 * commit something: the cards, the two sheets' openers, "Reopen session". A
 * bare listener behind a queued Update is a click that does nothing visible for
 * minutes and then produces a picker out of nowhere — and, when the Box refuses
 * it, an unhandled rejection nobody ever sees.
 *
 * What this is NOT is the safety: main enforces the Box Gate over every channel
 * that reaches the Box, including the ones no button here owns. This is the
 * SAYING — a screen that tells the Sandbox User why nothing is happening,
 * rather than one that quietly queues a second click behind a rebuild.
 */
let operationInFlight = false;

async function runOperation<T>(op: Operation<T>): Promise<void> {
  if (operationInFlight) {
    flash("Agentbox is already busy with something else. Let that finish first.");
    return;
  }
  operationInFlight = true;
  const label = op.button.textContent;
  op.button.disabled = true;
  if (op.busyLabel) op.button.textContent = op.busyLabel;

  const outcome = await op
    .run()
    .then((result) => ({ ok: true as const, result }), (err: unknown) => ({ ok: false as const, err }));

  // The operation is over either way, and it is over BEFORE `done` runs: `done`
  // re-renders a screen, and the screens now start operations of their own (a
  // finished Import opens the new Project's session). Holding the busy state
  // across the re-render would refuse the very click the re-render just made.
  operationInFlight = false;
  // The sheet goes before `done` runs: what follows a finished operation is
  // usually a re-render of the screen underneath it. Once, on either outcome.
  op.close?.();
  // A sheet takes its button with it; a button that stayed on screen has to be
  // handed back, or the screen is left with one dead control on it.
  if (!op.close) {
    op.button.disabled = false;
    if (op.busyLabel) op.button.textContent = label;
  }

  if (!outcome.ok) {
    flash(fail(op.failed, outcome.err));
    return;
  }
  // `done` is the screen catching up with an operation that already SUCCEEDED,
  // so its own failure is a different sentence: a Project that was deleted stays
  // deleted however the re-render behind it goes, and telling the Sandbox User
  // "Couldn't delete My website" about a delete that worked is worse than
  // telling them nothing.
  try {
    await op.done(outcome.result);
  } catch (err) {
    flash(fail("Done, but the screen couldn't refresh", err));
  }
}

/**
 * Elapsed wait, as a Sandbox User would say it out loud. TOTAL since the
 * starting screen appeared, never reset per phase: "it's been eleven minutes" is
 * the sentence they need when they give up and ask for help, and a clock that
 * restarts on every phase hides exactly that during the one phase long enough to
 * matter.
 */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * The folders the Files tab lists down its left pane: every directory that holds
 * a file, and every directory above one, so an indented list reads as a tree
 * without any tree state to keep. The Project root is deliberately NOT in here —
 * it is the "All files" row, which is the empty prefix and matches everything.
 */
function fileFolders(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop(); // the file's own name
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      folders.add(prefix);
    }
  }
  // Sorted on the separator swapped for NUL, so that every folder is followed by
  // its own descendants with no sibling wedged between them — which is what makes
  // indent-by-depth alone enough to draw the tree. A plain sort() breaks that for
  // any sibling name whose next character is below "/" (space, "-", ".", "+"):
  // "docs-old" lands between "docs" and "docs/2024", and "2024" then draws one
  // level under the wrong parent.
  const order = (folder: string) => folder.replaceAll("/", "\u0000");
  return [...folders].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

/** A folder row holds everything UNDER it, however deep. "" is the whole Project. */
function inFolder(path: string, folder: string): boolean {
  return folder === "" || path.startsWith(`${folder}/`);
}

/** The filter field: anywhere in the path, so "csv" finds data/2024-costs.csv. */
function matchesFilter(path: string, query: string): boolean {
  return path.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * What the Files tab's action bar says about the current ticking. The cap is the
 * Export ceiling (core/export.ts); this only decides whether "Save …" is
 * clickable, and the trusted layer re-checks both the selection and the total
 * before a byte is written.
 */
function selectionTotal(
  files: readonly { path: string; size: number }[],
  selected: ReadonlySet<string>,
  capBytes: number,
): { count: number; bytes: number; over: boolean } {
  const picked = files.filter((f) => selected.has(f.path));
  const bytes = picked.reduce((sum, f) => sum + f.size, 0);
  return { count: picked.length, bytes, over: bytes > capBytes };
}

/**
 * What a folder row holds — the blast radius of deleting it, which is the number
 * the confirmation sheet has to be able to say before anyone types anything. "" is
 * the whole Project, and a folder row takes everything under it however deep, so
 * this counts through `inFolder` rather than by prefix depth.
 *
 * The Box re-measures this before it removes a thing; what is drawn from here is
 * how much friction the click is worth, never the authority for it.
 */
function folderTotal(
  files: readonly { path: string; size: number }[],
  folder: string,
): { count: number; bytes: number } {
  const under = files.filter((f) => inFolder(f.path, folder));
  return { count: under.length, bytes: under.reduce((sum, f) => sum + f.size, 0) };
}

/**
 * What stays ticked when the Files tab is rebuilt. "Add files…" is an addition,
 * not a reset: someone who narrowed 200 files down to three and then added a
 * document has to end up with four ticked, not 201 — a click that copies out the
 * 198 they deliberately excluded. So the earlier ticks carry across, and any path
 * the earlier listing did not have — the files just added — starts ticked, the
 * same way it would on a first open.
 *
 * No `prior` is a first open or a Refresh: everything exportable starts ticked,
 * so "save all of it" is one click, and on Refresh the reset is what the word
 * implies.
 */
function carriedSelection(
  files: readonly { path: string; exportable: boolean }[],
  prior?: { selected: ReadonlySet<string>; known: ReadonlySet<string> },
): Set<string> {
  const keeps = (path: string): boolean =>
    !prior || prior.selected.has(path) || !prior.known.has(path);
  return new Set(files.filter((f) => f.exportable && keeps(f.path)).map((f) => f.path));
}

// --- end of the renderer's machinery -----------------------------------------

/**
 * `core/delete.ts`'s `folderName`, character for character, for the same reason
 * `normalize` below is a copy — the renderer cannot import from `core/`. Only the
 * sheet's own wording and its enabled state hang on it; the trusted layer takes
 * the folder's name from the path it validated, never from this.
 */
function folderName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * `core/delete.ts`'s normalisation rule, character for character, because the
 * renderer cannot import it (see `size` below). Only the button's enabled state
 * hangs on this copy — but a copy that drifted would enable "Delete forever" on
 * a name the trusted layer then refuses, so `test/renderer.test.ts` compares the
 * two sources.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Sizes for a Sandbox User: no bytes, no decimals below a gigabyte.
 *
 * `core/format.ts` holds the same function for the main process and explains why
 * this copy exists rather than an import. `test/renderer.test.ts` compares the
 * two sources, so the sheet and the dialog behind it can't start rounding
 * differently.
 */
function size(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * "just now" / a local date — the Sandbox User only needs the gist. The date
 * alone, not the second: this now sits on every Project row on the home screen,
 * where "7/24/2026, 6:49:47 PM" is precision nobody asked for in a subtitle.
 */
function when(epochMs?: number): string {
  if (!epochMs) return "recently";
  const minutes = Math.round((Date.now() - epochMs) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute(s) ago`;
  return new Date(epochMs).toLocaleDateString();
}
