/**
 * The home screen (ticket 05) and the in-Project session view (tickets 04/06/07/08).
 * Pure DOM against the narrow `window.claudebox` bridge — no Node, Docker, or
 * shell access here.
 */
const cb = window.claudebox;

const app = () => document.getElementById("app")!;

// --- the renderer's machinery ------------------------------------------------
// Everything between this marker and its closing twin touches nothing but
// `document` and `setTimeout`. That is deliberate: the renderer is a classic
// <script> and so can neither import nor export (see core/format.ts), and
// test/renderer.test.ts extracts this region verbatim and evaluates it against a
// fake DOM. Reaching for `cb`, a screen, or a global from in here is what would
// break that test — the rest of the file may lean on this region, never the
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
 * Every modal in Claudebox is this sheet: a backdrop, one panel, a title, the
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
 * Every operation below mutates the Box, and "Update Claudebox" recreates the
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
    flash("Claudebox is already busy with something else. Let that finish first.");
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
  // Lexicographic order puts every folder after its own ancestors, which is
  // what makes indent-by-depth alone enough to draw the tree.
  return [...folders].sort();
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

// --- end of the renderer's machinery -----------------------------------------

/**
 * The Nootka mark, held in the one circular element in the app — the barrel form,
 * used as a single hero accent rather than blanket roundness. The supplied asset
 * is the icon alone in black, so it sits on a white disc and is never recolored.
 */
function heroMark(): HTMLElement {
  return el("div", { className: "hero__mark" }, [
    el("div", { className: "hero__disc" }, [
      el("img", { src: "./assets/nootka-mark.png", alt: "Nootka Saunas" }),
    ]),
  ]);
}

/**
 * A full-bleed dark brand band split against a light panel holding the mark.
 *
 * Only the starting and error screens use this now — they ARE the whole window,
 * and `.hero:only-child` lets it fill one. The screens a Sandbox User works in
 * carry `brandBar` instead: a 40vh hero on top of the home screen put the one
 * thing they opened the Launcher for below the fold.
 */
function hero(copy: (Node | string)[]): HTMLElement {
  return el("header", { className: "hero" }, [
    el("div", { className: "hero__copy" }, copy),
    heroMark(),
  ]);
}

/**
 * The brand, one line high. It is what is left of the hero on the two working
 * screens: the mark and the name still open the window, but they cost a strip
 * rather than two fifths of it, so the projects list — and, inside a Project,
 * the controls — start at the top of the page instead of below a statement.
 */
function brandBar(children: (Node | string)[]): HTMLElement {
  return el("header", { className: "brandbar" }, [el("div", { className: "container" }, children)]);
}

/** The mark at bar scale — no disc, because a strip has no room for clear space. */
function brandMark(): HTMLElement {
  return el("img", { className: "brandbar__mark", src: "./assets/nootka-mark.png", alt: "Nootka Saunas" });
}

function section(kind: string, children: (Node | string)[]): HTMLElement {
  return el("section", { className: `section section--${kind}` }, [
    el("div", { className: "container" }, children),
  ]);
}

/**
 * Bad news that did not stop the launch, held under the hero until the Sandbox
 * User dismisses it. `role="status"` because it appears without them doing
 * anything, and the dismiss button is labelled for a screen reader — "×" is not
 * a word.
 */
function noticeStrip(message: string): HTMLElement {
  const strip = el("div", { className: "notice", role: "status" });
  const dismiss = el("button", {
    className: "notice__dismiss",
    textContent: "×",
    ariaLabel: "Dismiss this message",
  });
  dismiss.addEventListener("click", () => strip.remove());
  strip.append(el("p", { textContent: message }), dismiss);
  return strip;
}

/**
 * Place-anchored, and the same on every screen — plus, on the home screen, the
 * housekeeping. GitHub and "Claudebox itself" used to be two consecutive light
 * bands with full section weight, which between them took more of the home
 * screen than the Projects did. They are the same two controls here, at the size
 * of what they are: things you touch once a month, at the bottom, on one line.
 */
function footer(utilities: Node[] = []): HTMLElement {
  return el("footer", { className: "footer" }, [
    el("div", { className: "container footer__row" }, [
      el("span", { textContent: "Claudebox runs on your computer. Built in British Columbia." }),
      ...utilities,
    ]),
  ]);
}

/**
 * The home screen. Listing Projects FAILS rather than reporting an empty
 * Workspace when the Box can't be read, so this can go wrong — and it is
 * reached from four places (the bootstrap, "← All projects", a finished Delete,
 * signing out of GitHub), none of which has anything to add. So the one screen
 * that says the Box is unreachable is rendered here, once, and this never
 * rejects: a caller that had to remember `.catch` is a dead button waiting to
 * happen, which is exactly what three of those four were.
 *
 * `notice` is the launch's bad news on a launch that still worked — a rebuild
 * that failed, a refused definition — and only the bootstrap ever passes one.
 * It is a strip rather than a `flash` on purpose: a build is minutes long, the
 * Sandbox User has walked away, and a toast that expires while nobody is
 * looking is a `console.warn` with extra steps.
 */
async function renderHome(notice?: string): Promise<void> {
  let projects: Project[];
  try {
    projects = await cb.listProjects();
  } catch (err) {
    renderBootstrapError(fail("Couldn't read your projects", err));
    return;
  }
  const root = app();
  root.replaceChildren();

  root.append(
    brandBar([
      brandMark(),
      el("strong", { className: "brandbar__name", textContent: "Claudebox" }),
      el("p", {
        className: "brandbar__lead",
        textContent: "A sealed room. Nothing leaves it unless you carry it out.",
      }),
    ]),
  );

  if (notice) root.append(noticeStrip(notice));

  // The Projects (ticket 05) are the home screen now, first and at full width:
  // resuming yesterday's work is what the Launcher is opened for, and it used to
  // sit two bands down, behind a statement of what Claudebox is.
  //
  // Starting something new is the first tile rather than a band of its own —
  // both ways in (blank, or a folder from the computer) are the same intent, and
  // an empty Workspace then has its next step inside the grid instead of above it.
  const grid = el("div", { className: "grid" }, [newProjectCard()]);
  for (const project of projects) {
    grid.append(
      actionCard(project.name, savedMeta(project), () => void openProject(project)),
    );
  }

  root.append(
    section("light", [
      el("p", { className: "eyebrow", textContent: "Your projects" }),
      grid,
      ...(projects.length === 0
        ? [el("p", { className: "empty", textContent: "Nothing here yet — start one above." })]
        : []),
    ]),
  );

  root.append(footer([...(await githubAccountLine()), updateLink()]));
}

/**
 * What one Project row says besides its name. The Launcher knows exactly one
 * thing about a Project without asking the Box again, and it happens to be the
 * one worth saying: whether any of it is on the Sandbox User's own computer.
 * That is the sentence the Delete sheet leans on too, and the answer to "which
 * of these have I actually carried out yet".
 */
function savedMeta(project: Project): string {
  return project.lastSaved
    ? `Saved to your computer ${when(project.lastSaved)}`
    : "Not saved to your computer yet";
}

/** The one tile that isn't a Project: both ways of starting one. */
function newProjectCard(): HTMLButtonElement {
  const card = actionCard(
    "New project",
    "Blank, or a folder from your computer",
    () => renderNewProjectSheet(),
  );
  card.className = "card card--new";
  return card;
}

/**
 * Starting something new, on the sheet every other single decision in the app
 * uses. Both doors are here because they are one intent: a Sandbox User who
 * wants to work on the folder already on their desktop is starting a Project,
 * not browsing files — which is why "Open a folder from my computer" is here and
 * NOT in the Files tab, whose whole subject is one Project that already exists.
 */
function renderNewProjectSheet(): void {
  const nameInput = el("input", {
    type: "text",
    placeholder: "Name your project…",
    autocomplete: "off",
  }) as HTMLInputElement;

  const createBtn = el("button", { className: "btn", textContent: "Create blank project" }) as HTMLButtonElement;
  createBtn.disabled = true; // a Project with no name is refused by the trusted layer anyway
  nameInput.addEventListener("input", () => (createBtn.disabled = nameInput.value.trim() === ""));

  // Project Import (ticket 09): a folder on the host becomes a Project. One
  // confirmation sheet stands between the folder picker and anything crossing —
  // and the picker itself is opened by the trusted layer before it takes the Box
  // Gate, so this operation is only as long as measuring the chosen folder.
  const importBtn = el("button", {
    className: "btn--link",
    textContent: "Open a folder from my computer",
  }) as HTMLButtonElement;

  const cancel = el("button", { className: "btn--link", textContent: "Cancel" });

  const close = openSheet(
    "Start something new",
    [
      el("label", { className: "confirm" }, [
        el("span", { textContent: "What is it called?" }),
        nameInput,
      ]),
      el("p", {
        className: "sub",
        textContent:
          "Or bring one you already have: the folder is copied into the sandbox, and you'll see exactly what crosses before it does.",
      }),
      importBtn,
    ],
    [cancel, createBtn],
  );

  cancel.addEventListener("click", close); // cancelling creates nothing

  createBtn.addEventListener("click", () =>
    void runOperation({
      button: createBtn,
      busyLabel: "Creating…",
      close,
      run: () => cb.createProject(nameInput.value.trim()),
      done: (project) => openProject(project),
      failed: "Couldn't create that project",
    }),
  );

  importBtn.addEventListener("click", () =>
    void runOperation({
      button: importBtn,
      busyLabel: "Opening…",
      run: () => cb.planImport(),
      // Undefined means the native picker was cancelled: nothing crossed, so
      // there is nothing to confirm — and this sheet stays up, because the
      // Sandbox User has not finished deciding what to start.
      done: (listing) => {
        if (!listing) return;
        close();
        renderImportSheet(listing);
      },
      failed: "Couldn't read that folder",
    }),
  );

  nameInput.focus();
}

/**
 * "Update Claudebox" — Refresh on Launch (ADR 0002) on a button, for the gap it
 * leaves: a fix ships, and a Sandbox User who never quits the Launcher stays on
 * last week's Box with no way to ask for the new one.
 *
 * Home screen only, and a footer link rather than a band of its own. Updating
 * restarts the sandbox and closes every open Claude session, which is not a
 * thing to put a click away from a Project tile — and it is nobody's reason for
 * opening the Launcher.
 */
function updateLink(): HTMLButtonElement {
  const update = el("button", { className: "btn--link", textContent: "Update Claudebox" }) as HTMLButtonElement;

  update.addEventListener("click", () =>
    void runOperation({
      button: update,
      busyLabel: "Checking…",
      run: () => cb.updateBox(),
      // Undefined means the confirmation was cancelled: nothing was checked, so
      // there is nothing to report.
      done: (message) => {
        if (message) flash(message);
      },
      failed: "Couldn't update Claudebox",
    }),
  );

  return update;
}

/**
 * The connected GitHub Account (ADR 0006). One account at a time — the token is
 * the Sandbox User's own — and this is the only place to change which one, so it
 * lives on the home screen rather than inside a Project.
 *
 * Absent entirely when nothing is connected: the "Save to GitHub" card already
 * offers to connect, and an empty row here would be a second, deader door.
 */
async function githubAccountLine(): Promise<Node[]> {
  let status: GithubStatus;
  try {
    status = await cb.githubStatus();
  } catch {
    return []; // never let a GitHub hiccup keep the home screen from rendering
  }
  if (!status.connected) return [];

  const swap = el("button", {
    className: "btn--link",
    textContent: "Use a different account",
  }) as HTMLButtonElement;
  swap.addEventListener("click", () =>
    void runOperation({
      button: swap,
      busyLabel: "Signing out…",
      run: () => cb.disconnectGithub(),
      done: () => {
        flash("Signed out of GitHub. The next “Save to GitHub” will ask which account to use.");
        return renderHome();
      },
      failed: "Couldn't sign out of GitHub",
    }),
  );

  return [el("span", { textContent: `Saving to ${status.login}'s account.` }), swap];
}

/**
 * One action, its plain-language consequence, and the click that does it. The
 * card is handed to its own handler because every one of these reaches the Box:
 * they run as operations, and an operation disables the control that started it.
 */
function actionCard(
  title: string,
  description: string,
  onClick: (card: HTMLButtonElement) => void,
): HTMLButtonElement {
  const card = el("button", { className: "card" }, [
    el("strong", { textContent: title }),
    el("span", { textContent: description }),
  ]) as HTMLButtonElement;
  card.addEventListener("click", () => onClick(card));
  return card;
}

/**
 * The per-Project control panel (ticket 04). The Claude session opens in its own
 * window (via openSession); this window becomes the controls for the active
 * Project — no terminal is embedded here.
 *
 * Opening a Project does NOT open the session: landing here is how a user gets
 * to the files and the publish too, and having a terminal appear over the panel
 * every time they came back for one of those was noise. The session opens when
 * it is asked for, and asking twice raises the window rather than adding one.
 *
 * Two tabs, because the panel holds two subjects that were competing for one
 * grid: what you DO with this Project, and what is IN it.
 */
async function openProject(project: Project): Promise<void> {
  const root = app();
  root.replaceChildren();

  // The way out sits top-left, in the slot the "Open project" eyebrow held: that
  // eyebrow only restated the screen you were already looking at, and the back
  // control is the one thing on this panel that has a conventional home.
  const back = el("button", { className: "back" }, [
    el("span", {
      className: "back__icon",
      innerHTML:
        '<svg width="16" height="12" viewBox="0 0 14 10" fill="none" aria-hidden="true"><path d="M5 1L1 5l4 4M1 5h12" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>',
    }),
    "All projects",
  ]);
  back.addEventListener("click", () => void renderHome());

  // Opens the session window, or brings the open one to the front — the tmux
  // session behind it is the same either way. It is an operation like every
  // other Box-touching control: bringing the Box up can take a while, so the
  // button that asked for it is also what says whether it came up.
  const openSession = el("button", {
    className: "btn",
    textContent: "Open session",
  }) as HTMLButtonElement;
  openSession.addEventListener(
    "click",
    () =>
      void runOperation({
        button: openSession,
        busyLabel: "Opening…",
        run: () => cb.openSession(project.slug),
        done: () => undefined,
        failed: "Couldn't open the Claude session",
      }),
  );

  const sessionTab = el("button", { className: "tab tab--on", textContent: "Session" }) as HTMLButtonElement;
  const filesTab = el("button", { className: "tab", textContent: "Files" }) as HTMLButtonElement;

  // One region under the bar, swapped in place. The tabs are the only navigation
  // in the app that isn't a whole screen, so they change as little as possible:
  // the bar, the Project's name and the way out all stay where they were.
  const body = el("div", { className: "tabbed" });
  const select = (tab: HTMLButtonElement, content: Node): void => {
    for (const t of [sessionTab, filesTab]) t.className = t === tab ? "tab tab--on" : "tab";
    body.replaceChildren(content);
  };

  // The Files tab reads the Project ONCE, when it is opened, and again only when
  // the Sandbox User asks for it (Refresh) or changes what is there (Add files…).
  // Nothing here is on a timer: every read takes the Box Gate, which is not
  // re-entrant, so a poll would sit on the lock the session itself needs.
  const loadFiles = (button: HTMLButtonElement): void =>
    void runOperation({
      button,
      run: () => cb.listExportFiles(project.slug),
      done: (listing) => select(filesTab, filesPanel(project, listing, loadFiles)),
      failed: `Couldn't read the files in ${project.name}`,
    });

  sessionTab.addEventListener("click", () => select(sessionTab, sessionPanel(project)));
  filesTab.addEventListener("click", () => loadFiles(filesTab));

  root.append(
    brandBar([
      back,
      el("h1", { className: "brandbar__project", textContent: project.name }),
      el("nav", { className: "tabs" }, [sessionTab, filesTab]),
      openSession,
    ]),
  );

  select(sessionTab, sessionPanel(project));
  root.append(section("light", [body]));
  root.append(footer());
}

/**
 * What you DO with this Project. Two cards, because the grid's own rule is that
 * an even set reads as a block and an odd one reads as three-plus-an-orphan — it
 * had grown to five. Three of those five were file transfer and moved into the
 * Files tab, which also ended the screen having three different buttons whose
 * first word was "save".
 *
 * Both reach into the Box, so both are operations: each disables its own card,
 * refuses while another is in flight rather than queueing silently behind a
 * rebuild, and — the thing an unhandled rejection could never do — says so when
 * it fails instead of looking simply dead.
 */
function sessionPanel(project: Project): HTMLElement {
  const preview = actionCard("Preview", "Look at whatever this project is serving.", (card) =>
    void runOperation({
      button: card,
      run: () => cb.openPreview(),
      done: (res) =>
        flash(res.opened ? `Opened ${res.url}` : "Nothing is being served yet — ask Claude to start a server."),
      failed: "Couldn't open the preview",
    }),
  );

  // Save to GitHub (ADR 0006) stays here rather than moving to Files: it is
  // publishing the Project to an account, not carrying files onto this computer.
  // The token lives in the Launcher; this button only asks for the publish, and
  // the two-container split happens on the host side.
  const github = actionCard("Save to GitHub", "Keep this project in a private repo on your account.", (card) =>
    void startPublish(project, card),
  );

  // Delete sits OUTSIDE the action grid, not as another card in it. The two
  // above are things you can undo by doing them again; this one is the only
  // control in Claudebox that destroys work, and putting it in the same row of
  // identical cards would make it a misclick away from the one beside it.
  const destroy = el("button", {
    className: "btn--link destroy",
    textContent: "Delete this project",
  }) as HTMLButtonElement;
  destroy.addEventListener("click", () =>
    void runOperation({
      button: destroy,
      busyLabel: "Checking…",
      run: () => cb.planDelete(project.slug),
      done: (listing) => renderDeleteSheet(project, listing),
      failed: `Couldn't open ${project.name} to delete it`,
    }),
  );

  return el("div", {}, [
    el("p", { className: "eyebrow", textContent: "This project" }),
    el("div", { className: "grid grid--actions" }, [preview, github]),
    el("div", { className: "danger" }, [
      el("p", {
        textContent:
          "Finished with this project? Deleting it removes it and everything in it from the sandbox, for good.",
      }),
      destroy,
    ]),
  ]);
}

/**
 * The Files tab (tickets 07/08): everything in one Project, and the three things
 * a Sandbox User does with it — bring files in, carry files out, and look at
 * what has already been carried out. Those used to be three cards on the panel,
 * two of which said "save", each of which answered its question in a toast that
 * expired. Here the answer is the list itself.
 *
 * The Launcher builds this from what IT enumerated inside the Box — nothing
 * served from inside the Box decides what the host writes — and everything
 * ticked is still re-validated in the trusted layer before a byte is written, so
 * this pane is a convenience, never the security boundary.
 *
 * Refused files are listed, greyed, with the reason `core/export.ts` gave beside
 * them. Hiding them would be the kinder-looking bug: a user whose analysis script
 * doesn't come out should read why here, not wonder about it afterwards.
 */
function filesPanel(
  project: Project,
  listing: ExportListing,
  reload: (button: HTMLButtonElement) => void,
): HTMLElement {
  const paths = listing.files.map((f) => f.path);
  // Exportable files start ticked, so "save all of it" is still one click — the
  // default the sheet this replaced had.
  const selected = new Set(listing.files.filter((f) => f.exportable).map((f) => f.path));
  let folder = ""; // the whole Project
  let query = "";

  const tree = el("ul", { className: "tree" });
  const list = el("ul", { className: "files" });
  const total = el("span", { className: "total" });
  const filter = el("input", {
    type: "search",
    placeholder: "Filter files…",
    autocomplete: "off",
  }) as HTMLInputElement;
  const add = el("button", { className: "btn--link", textContent: "Add files…" }) as HTMLButtonElement;
  const refresh = el("button", { className: "btn--link", textContent: "Refresh" }) as HTMLButtonElement;
  const saveBtn = el("button", { className: "btn" }) as HTMLButtonElement;
  const openSaved = el("button", { className: "btn--link", textContent: "Open that folder" }) as HTMLButtonElement;

  function drawTree(): void {
    tree.replaceChildren();
    for (const dir of ["", ...fileFolders(paths)]) {
      const row = el("button", {
        className: dir === folder ? "tree__row tree__row--on" : "tree__row",
        // Only the last segment: the row above it already said the rest.
        textContent: dir === "" ? "All files" : dir.slice(dir.lastIndexOf("/") + 1),
      });
      row.style.paddingLeft = `${0.75 + (dir === "" ? 0 : dir.split("/").length) * 0.8}rem`;
      row.addEventListener("click", () => {
        folder = dir;
        drawTree();
        drawFiles();
      });
      tree.append(el("li", {}, [row]));
    }
  }

  function drawFiles(): void {
    const shown = listing.files.filter((f) => inFolder(f.path, folder) && matchesFilter(f.path, query));
    list.replaceChildren();
    for (const file of shown) {
      const check = el("input", {
        type: "checkbox",
        checked: selected.has(file.path),
        disabled: !file.exportable,
      }) as HTMLInputElement;
      check.addEventListener("change", () => {
        if (check.checked) selected.add(file.path);
        else selected.delete(file.path);
        drawTotal();
      });
      list.append(
        el("li", {}, [
          el("label", { className: file.exportable ? "file" : "file blocked" }, [
            check,
            el("span", {
              className: "name",
              // Relative to the folder on the left: picking one shortens the rows
              // instead of repeating the path you just clicked.
              textContent: folder === "" ? file.path : file.path.slice(folder.length + 1),
            }),
            el("span", {
              className: "why",
              // core/export.ts owns these sentences. They are shown as written.
              textContent: file.exportable ? size(file.size) : file.reason ?? "",
            }),
          ]),
        ]),
      );
    }
    if (shown.length === 0) {
      list.append(
        el("li", {}, [
          el("p", {
            className: "empty",
            textContent: query ? "Nothing here matches that." : "Nothing in this folder yet.",
          }),
        ]),
      );
    }
    drawTotal();
  }

  // The count is on the button because it is what the click will do, and the
  // total is beside it because the cap is the reason a click might be refused.
  // Selection survives switching folders and filtering: ticking things in two
  // folders and saving both is the whole point of keeping it in one place.
  function drawTotal(): void {
    const picked = selectionTotal(listing.files, selected, listing.capBytes);
    total.textContent = picked.over
      ? `${size(picked.bytes)} — over the ${size(listing.capBytes)} limit. Untick something.`
      : `${size(picked.bytes)} of ${size(listing.capBytes)}`;
    total.className = picked.over ? "total over" : "total";
    saveBtn.textContent =
      picked.count === 1 ? "Save 1 file to my computer" : `Save ${picked.count} files to my computer`;
    saveBtn.disabled = picked.over || picked.count === 0;
  }

  filter.addEventListener("input", () => {
    query = filter.value;
    drawFiles();
  });

  refresh.addEventListener("click", () => reload(refresh));

  add.addEventListener("click", () =>
    void runOperation({
      button: add,
      busyLabel: "Adding…",
      run: () => cb.upload(project.slug),
      // An empty list is a cancelled picker, not a failed copy — and nothing
      // changed, so there is nothing to read again.
      done: (copied) => {
        if (!copied.length) return;
        flash(`Added ${copied.length} file(s) to ${project.name}.`);
        reload(add);
      },
      failed: "Couldn't add those files",
    }),
  );

  saveBtn.addEventListener("click", () =>
    void runOperation({
      button: saveBtn,
      busyLabel: "Saving…",
      run: () => cb.saveToComputer(project.slug, [...selected]),
      done: (res) =>
        flash(
          res.overCap
            ? `Too big to save: ${size(res.totalBytes)}, and the limit is ${size(res.capBytes)}. Nothing was saved.`
            : saved(res),
        ),
      failed: "Couldn't save",
    }),
  );

  openSaved.addEventListener("click", () =>
    void runOperation({
      button: openSaved,
      busyLabel: "Opening…",
      run: () => cb.showSavedFiles(project.slug),
      done: (res) => {
        if (!res.opened) flash(`Nothing saved yet — the folder appears the first time you save.`);
      },
      failed: "Couldn't open the saved folder",
    }),
  );

  drawTree();
  drawFiles();

  return el("div", {}, [
    el("p", { className: "eyebrow", textContent: "Files in this project" }),
    el("div", { className: "two" }, [
      tree,
      el("div", {}, [
        el("div", { className: "tools" }, [filter, add, refresh]),
        list,
        el("div", { className: "bar" }, [saveBtn, total]),
      ]),
    ]),
    // "Show saved files" was a card that answered a question with a toast. The
    // answer is on screen now, and the button only opens the folder.
    el("div", { className: "saved" }, [
      el("span", { textContent: `Saved copies land in ${listing.dir}.` }),
      openSaved,
    ]),
  ]);
}

/**
 * "Save to GitHub" (ADR 0006). Connecting comes first if it has to, and the
 * publish follows from the same click — a Sandbox User asked to save, not to
 * sign in, so the sign-in is a step inside that, never a separate errand.
 */
async function startPublish(project: Project, card: HTMLButtonElement): Promise<void> {
  let status: GithubStatus;
  try {
    // Host-only, and the one step here that isn't the operation: reading the
    // connected Account never reaches the Box, so it neither takes the busy
    // state nor waits for it.
    status = await cb.githubStatus();
  } catch (err) {
    flash(fail("Couldn't check your GitHub account", err));
    return;
  }

  if (!status.configured) {
    flash("This copy of Claudebox has no GitHub sign-in configured, so it can't save there yet.");
    return;
  }
  if (!status.connected) {
    // Signing in is minutes of polling GitHub and touches nothing — it stays
    // outside the busy state, exactly as it stays outside the Box Gate.
    renderGithubConnect(project, card);
    return;
  }
  await publish(project, card);
}

function publish(project: Project, card: HTMLButtonElement): Promise<void> {
  return runOperation({
    button: card,
    // Said from inside `run`, so a publish that was REFUSED for being second in
    // line doesn't announce itself first and then deny it.
    run: () => (flash(`Saving ${project.name} to GitHub…`), cb.saveToGithub(project.slug)),
    // Naming the branch matters: it is whatever was checked out in the Box, and
    // on a feature branch the repo's front page will not show what was just
    // saved. "(private)" only when Claudebox made the repo — a Project that came
    // in with its own remote publishes back to it, whatever that repo already is.
    done: (res) =>
      flash(
        res.created
          ? `Created ${res.url} (private) — branch ${res.branch}.`
          : `Saved to ${res.url} — branch ${res.branch}.`,
      ),
    failed: "Couldn't save to GitHub",
  });
}

/**
 * The GitHub device-flow sheet. Shows the code to type at github.com/login/device
 * and — plainly, because it is the whole cost of this feature — what the sign-in
 * lets Claudebox reach.
 */
function renderGithubConnect(project: Project, card: HTMLButtonElement): void {
  const step = el("p", { className: "sub", textContent: "Asking GitHub for a code…" });
  const code = el("p", { className: "total" });
  const cancel = el("button", { className: "btn--link", textContent: "Cancel" });

  const close = openSheet(
    "Connect GitHub",
    [
      step,
      code,
      el("p", {
        className: "sub",
        textContent:
          "Claudebox asks for access to your repositories so it can create a private one and save this project into it. " +
          "The sign-in is kept by this launcher and is never given to Claude.",
      }),
      // The switching trap: the code is approved by whoever is signed in at
      // github.com, so a second account needs a signed-out (or private) browser.
      el("p", {
        className: "sub",
        textContent:
          "GitHub connects whichever account is signed in to your browser. To use a different one, sign out of github.com first.",
      }),
    ],
    [cancel],
  );
  cancel.addEventListener("click", close);

  void (async () => {
    try {
      const device = await cb.startGithubLogin();
      step.textContent = `Go to ${device.verificationUri} and enter this code:`;
      code.textContent = device.userCode;
      // Resolves only once the user has approved on github.com, so the sheet
      // stays up — cancelling here just closes it; nothing is stored either way.
      await cb.awaitGithubLogin();
      close();
      await publish(project, card);
    } catch (err) {
      close();
      flash(fail("Couldn't connect GitHub", err));
    }
  })();
}

/**
 * The Delete Project confirmation sheet. Deleting is permanent and the Box holds
 * the only copy (core/delete.ts), so this sheet does three things before it will
 * enable its button: it says exactly how much is about to go, it says what
 * SURVIVES on the user's own computer — the strongest reassurance available, and
 * the thing that tells someone they should hit Cancel and save first — and it
 * makes them type the Project's name, so this can never be a slipped click.
 */
function renderDeleteSheet(project: Project, listing: DeleteListing): void {
  const confirmName = el("input", {
    type: "text",
    placeholder: listing.name,
    // A password manager or an autofilled name would defeat the whole point.
    autocomplete: "off",
    spellcheck: false,
  }) as HTMLInputElement;

  const remove = el("button", { className: "btn", textContent: "Delete forever" }) as HTMLButtonElement;
  const cancel = el("button", { className: "btn--link", textContent: "Cancel" });

  const close = openSheet(
    "Delete this project",
    [
      el("p", { className: "sub", textContent: listing.name }),
      el("p", {
        className: "total",
        textContent:
          listing.fileCount === undefined || listing.totalBytes === undefined
            ? "Everything in this project will be deleted. (Its size couldn't be measured.)"
            : `${listing.fileCount} file(s), ${size(listing.totalBytes)} — all of it deleted.`,
      }),
      el("p", {
        textContent:
          "This can't be undone. There's no trash in the sandbox, and the copy in here is the only one.",
      }),
      // The one piece of good news, and load-bearing: someone who reads "nothing
      // has been saved" should cancel and use "Save to my computer" first.
      el("p", {
        className: "sub",
        textContent: listing.lastSaved
          ? `Files you already saved to your computer stay where they are, in ${listing.exportDir} (last saved ${when(listing.lastSaved)}).`
          : "Nothing from this project has been saved to your computer yet — once it's deleted, it's gone.",
      }),
      el("label", { className: "confirm" }, [
        el("span", { textContent: `Type ${listing.name} below to confirm.` }),
        confirmName,
      ]),
    ],
    [cancel, remove],
  );

  const refresh = () => {
    // The renderer's copy of the rule is for enabling the button only; the
    // trusted layer re-checks the typed name before anything is removed.
    remove.disabled = normalize(confirmName.value) !== normalize(listing.name);
  };
  confirmName.addEventListener("input", refresh);
  refresh();

  cancel.addEventListener("click", close); // cancelling deletes nothing

  remove.addEventListener("click", () =>
    void runOperation({
      button: remove,
      busyLabel: "Deleting…",
      close,
      run: () => cb.deleteProject(project.slug, confirmName.value),
      done: async (res) => {
        // Back to the home screen: the Project this panel is controlling is gone.
        await renderHome();
        // The session's Chrome window is a separate window this app can't close,
        // and it is still sitting there — so say so rather than leave the user
        // looking at a dead terminal for a Project the Launcher says is deleted.
        flash(
          res.sessionKilled
            ? `Deleted ${res.name}. Its Claude window is finished — you can close it.`
            : `Deleted ${res.name}.`,
        );
      },
      failed: `Couldn't delete ${listing.name}`,
    }),
  );

  confirmName.focus();
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
 * The Project Import confirmation sheet (ticket 09) — folder name, exact size,
 * whether `.gitignore` filtered anything, and the consent sentence, on the one
 * `openSheet` every modal here uses. Cancel copies nothing;
 * "Bring it in" is disabled outright when the folder doesn't fit the Box.
 */
function renderImportSheet(listing: ImportListing): void {
  const bring = el("button", { className: "btn", textContent: "Bring it in" }) as HTMLButtonElement;
  bring.disabled = !listing.fitsFreeSpace; // refused before anything crosses, not after
  const cancel = el("button", { className: "btn--link", textContent: "Cancel" });

  const contents: (Node | string)[] = [
    el("p", { className: "sub", textContent: listing.folderName }),
    // The warning and the mechanism key off different conditions (ticket 09):
    // this fires on the absence of a root .gitignore, regardless of whether the
    // folder is a git repo at all.
    el("p", {
      textContent: listing.hasGitignore
        ? "Filtered by this project's .gitignore — files it ignores (like node_modules) are left out."
        : "No .gitignore was found here, so everything in the folder will be copied.",
    }),
  ];

  if (listing.isGitRepo) {
    contents.push(
      el("p", { textContent: "This is a git repository — its full history (.git) comes along too." }),
    );
  }

  contents.push(
    el("p", {
      className: "total",
      textContent: listing.overWarnThreshold
        ? `${listing.fileCount} file(s), ${size(listing.totalBytes)} — that's a lot to bring in.`
        : `${listing.fileCount} file(s), ${size(listing.totalBytes)}.`,
    }),
  );

  if (!listing.fitsFreeSpace) {
    contents.push(
      el("p", {
        className: "total over",
        textContent: `Not enough room in the Box: this needs ${size(listing.totalBytes)}, and only ${size(listing.freeBytes)} is free.`,
      }),
    );
  }

  contents.push(
    el("p", {
      className: "sub",
      textContent: "Once you click below, Claude will be able to read and change everything in this folder.",
    }),
  );

  const close = openSheet("Bring in a project", contents, [cancel, bring]);

  cancel.addEventListener("click", close); // cancelling copies nothing

  bring.addEventListener("click", () =>
    void runOperation({
      button: bring,
      busyLabel: "Bringing it in…",
      close,
      run: () => cb.importFolder(listing.folder),
      done: (project) => openProject(project),
      failed: "Couldn't bring that in",
    }),
  );
}

/**
 * What one Export did. Files that landed without the host's untrusted mark
 * (#12) are named rather than folded into the count: the mark is what puts them
 * in "the risk class of an email attachment" (ADR 0003), so its absence is
 * something the Sandbox User is entitled to hear before they open one.
 */
function saved(res: ExportResult): string {
  const done = `Saved ${res.saved} file(s) to ${res.dir}.`;
  if (res.unmarked === 0) return done;
  return `${done} ${res.unmarked} couldn't be marked as coming from Claudebox — open those with the same care as an email attachment.`;
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

/**
 * The starting screen, painted ONCE and then updated in place. Re-rendering it
 * per phase would restart the clock and jump the hero, and the clock is the only
 * thing on screen that proves the Launcher is still alive during the several
 * minutes a first build takes.
 */
let startingStep: HTMLElement | undefined;
let startingClock: ReturnType<typeof setInterval> | undefined;

function renderStarting(message: string): void {
  if (startingStep) {
    startingStep.textContent = message;
    return;
  }
  const step = el("p", { className: "lead", textContent: message });
  const elapsed = el("p", { className: "elapsed", textContent: clock(0) });
  const startedAt = Date.now();
  startingStep = step;
  startingClock = setInterval(() => (elapsed.textContent = clock(Date.now() - startedAt)), 1000);
  app().replaceChildren(
    hero([
      el("p", { className: "eyebrow", textContent: "Claudebox" }),
      el("h1", { className: "hero__title", textContent: "Warming the room." }),
      step,
      elapsed,
    ]),
  );
}

/**
 * Every way off the starting screen goes through here. The interval outlives the
 * nodes it writes to — `replaceChildren` detaches them without stopping it — so
 * a launch that ends without this ticks for the life of the Launcher.
 */
function stopStarting(): void {
  if (startingClock !== undefined) clearInterval(startingClock);
  startingClock = undefined;
  startingStep = undefined;
}

function renderBootstrapError(message: string): void {
  app().replaceChildren(
    hero([
      el("p", { className: "eyebrow", textContent: "Claudebox" }),
      el("h1", { className: "hero__title", textContent: "The room stayed cold." }),
      el("p", { className: "error", textContent: message }),
    ]),
  );
}

// Escape goes back to the projects list, and does it by pressing the button that
// is already on screen: no second copy of "what does back mean", and nothing to
// unbind per screen — the shortcut exists exactly when the button does. Sheets
// have no Escape of their own, so an open one swallows the key rather than
// dropping the Sandbox User out from under it.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || document.querySelector(".sheet")) return;
  document.querySelector<HTMLButtonElement>(".back")?.click();
});

// Wait for the Engine + Box to be ready before the home screen queries Projects
// (they live on a named volume reached through the running Box).
renderStarting("Getting the sandbox ready…");
window.claudebox.onBootstrap((status) => {
  // `working` is the sub-line of the screen already up, and arrives as often as
  // the launch has something new to say; the two terminal statuses each arrive
  // once and are what take the screen down.
  if ("phase" in status) {
    renderStarting(status.message);
    return;
  }
  stopStarting();
  // `renderHome` renders its own failure (a listing that can't reach the Box
  // leaves the Sandbox User on "Warming the room" forever otherwise), so there
  // is nothing to catch out here.
  if (status.ok) void renderHome(status.notice);
  else renderBootstrapError(status.message);
});
