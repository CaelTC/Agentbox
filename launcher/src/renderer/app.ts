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
  /** What the button says while it runs — "Saving…", "Deleting…". */
  busyLabel: string;
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
  op.button.textContent = op.busyLabel;
  try {
    const result = await op.run();
    // The sheet goes before `done` runs: what follows a finished operation is
    // usually a re-render of the screen underneath it.
    op.close?.();
    await op.done(result);
  } catch (err) {
    op.close?.();
    flash(`${op.failed}: ${(err as Error).message}`);
  } finally {
    operationInFlight = false;
    // A sheet takes its button with it; a button that stayed on screen has to be
    // handed back, or the screen is left with one dead control on it.
    if (!op.close) {
      op.button.disabled = false;
      op.button.textContent = label;
    }
  }
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

/** A full-bleed dark brand band split against a light panel holding the mark. */
function hero(copy: (Node | string)[], modifier = ""): HTMLElement {
  return el("header", { className: `hero ${modifier}`.trim() }, [
    el("div", { className: "hero__copy" }, copy),
    heroMark(),
  ]);
}

function section(kind: string, children: (Node | string)[]): HTMLElement {
  return el("section", { className: `section section--${kind}` }, [
    el("div", { className: "container" }, children),
  ]);
}

/** Place-anchored, and the same on every screen. */
function footer(): HTMLElement {
  return el("footer", { className: "footer" }, [
    el("div", { className: "container" }, ["Claudebox runs on your computer. Built in British Columbia."]),
  ]);
}

async function renderHome(): Promise<void> {
  const projects = await cb.listProjects();
  const root = app();
  root.replaceChildren();

  root.append(
    hero([
      el("p", { className: "eyebrow", textContent: "Claudebox" }),
      el("h1", { className: "hero__title", textContent: "A sealed room." }),
      el("p", {
        className: "lead",
        textContent:
          "Claude works inside a sandbox on your computer. Nothing leaves it unless you carry it out.",
      }),
    ]),
  );

  // A blank Project.
  const nameInput = el("input", { type: "text", placeholder: "Name your project…" }) as HTMLInputElement;
  const createBtn = el("button", { className: "btn", textContent: "Create blank project" });
  createBtn.addEventListener("click", async () => {
    if (!nameInput.value.trim()) return;
    const project = await cb.createProject(nameInput.value.trim());
    await openProject(project);
  });

  // Project Import (ticket 09): a folder on the host becomes a Project. One
  // confirmation sheet stands between the folder picker and anything crossing.
  const importBtn = el("button", { className: "btn", textContent: "Open a folder from my computer" });
  importBtn.addEventListener("click", () => void startImport());

  root.append(
    section("light", [
      el("p", { className: "eyebrow", textContent: "Start something new" }),
      el("div", { className: "new-project" }, [nameInput, createBtn]),
      el("div", { className: "new-project" }, [importBtn]),
    ]),
  );

  // Existing Projects (ticket 05) — a dark band, so the list reads as its own place.
  const projectBlock: (Node | string)[] = [el("p", { className: "eyebrow", textContent: "Your projects" })];
  if (projects.length === 0) {
    projectBlock.push(
      el("p", { className: "empty", textContent: "Nothing here yet. Start one above and it will appear." }),
    );
  } else {
    const list = el("ul", { className: "projects" });
    for (const p of projects) {
      const open = el("button", {}, [
        el("span", { textContent: p.name }),
        el("span", { className: "meta", textContent: "Open" }),
      ]);
      open.addEventListener("click", () => openProject(p));
      list.append(el("li", {}, [open]));
    }
    projectBlock.push(list);
  }
  root.append(section("water", projectBlock));
  const account = await githubAccountSection();
  if (account) root.append(account);
  root.append(updateSection());
  root.append(footer());
}

/**
 * "Update Claudebox" — Refresh on Launch (ADR 0002) on a button, for the gap it
 * leaves: a fix ships, and a Sandbox User who never quits the Launcher stays on
 * last week's Box with no way to ask for the new one.
 *
 * Home screen only, and a quiet link rather than a card. Updating restarts the
 * sandbox and closes every open Claude session, which is not a thing to put a
 * click away from "Open project" — and it is nobody's reason for opening the
 * Launcher.
 */
function updateSection(): HTMLElement {
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

  return section("light", [
    el("p", { className: "eyebrow", textContent: "Claudebox itself" }),
    el("p", {
      textContent:
        "Claudebox updates itself each time you open it. If you've been told there's a fix, you can check now instead.",
    }),
    update,
  ]);
}

/**
 * The connected GitHub Account (ADR 0006). One account at a time — the token is
 * the Sandbox User's own — and this is the only place to change which one, so it
 * lives on the home screen rather than inside a Project.
 *
 * Absent entirely when nothing is connected: the "Save to GitHub" card already
 * offers to connect, and an empty row here would be a second, deader door.
 */
async function githubAccountSection(): Promise<HTMLElement | undefined> {
  let status: GithubStatus;
  try {
    status = await cb.githubStatus();
  } catch {
    return undefined; // never let a GitHub hiccup keep the home screen from rendering
  }
  if (!status.connected) return undefined;

  const swap = el("button", { className: "btn--link", textContent: "Use a different account" });
  swap.addEventListener("click", async () => {
    await cb.disconnectGithub();
    flash("Signed out of GitHub. The next “Save to GitHub” will ask which account to use.");
    await renderHome();
  });

  return section("light", [
    el("p", { className: "eyebrow", textContent: "GitHub" }),
    el("p", { textContent: `Saving to ${status.login}'s account.` }),
    swap,
  ]);
}

/** One action, its plain-language consequence, and the click that does it. */
function actionCard(title: string, description: string, onClick: () => void): HTMLElement {
  const card = el("button", { className: "card" }, [
    el("strong", { textContent: title }),
    el("span", { textContent: description }),
  ]);
  card.addEventListener("click", onClick);
  return card;
}

/**
 * The per-Project control panel (ticket 04). The Claude session itself opens in
 * a separate Chrome app-mode window (via openSession); this window becomes the
 * controls for the active Project — no terminal is embedded here.
 */
async function openProject(project: Project): Promise<void> {
  const root = app();
  root.replaceChildren();

  const back = el("button", { className: "btn--link", textContent: "← All projects" });
  back.addEventListener("click", () => void renderHome());

  // Re-open the Chrome window on the same live session (still alive in tmux).
  const reopen = el("button", { className: "btn", textContent: "Reopen session" });
  reopen.addEventListener("click", () => void cb.openSession(project.slug));

  root.append(
    hero(
      [
        el("p", { className: "eyebrow", textContent: "Open project" }),
        el("h1", { className: "hero__title", textContent: project.name }),
        el("p", { className: "lead", textContent: "Claude is waiting in its own window. This one holds the controls." }),
        el("div", { className: "hero__actions" }, [reopen, back]),
      ],
      "hero--project",
    ),
  );

  const upload = actionCard("Upload files", "Bring documents in from your computer.", async () => {
    const copied = await cb.upload(project.slug);
    if (copied.length) flash(`Uploaded ${copied.length} file(s) into ${project.name}.`);
  });

  // Export (tickets 07/08): carry the Project's documents onto the real computer.
  // Both of these reach into the Box, so both can fail before they show anything
  // — an unreported rejection would leave the button looking simply dead.
  const save = actionCard("Save to my computer", "Carry this project's files back out.", async () => {
    try {
      renderExportPicker(project, await cb.listExportFiles(project.slug));
    } catch (err) {
      flash(`Couldn't open ${project.name} to save it: ${(err as Error).message}`);
    }
  });

  const show = actionCard("Show saved files", "Open the folder the saved copies land in.", async () => {
    try {
      const res = await cb.showSavedFiles(project.slug);
      flash(
        res.opened
          ? `Last saved ${when(res.lastSaved)}.`
          : `Nothing saved yet — “Save to my computer” puts this project in ${res.dir}.`,
      );
    } catch (err) {
      flash(`Couldn't show the saved files: ${(err as Error).message}`);
    }
  });

  const preview = actionCard("Preview", "Look at whatever this project is serving.", async () => {
    const res = await cb.openPreview();
    flash(res.opened ? `Opened ${res.url}` : "Nothing is being served yet — ask Claude to start a server.");
  });

  // Save to GitHub (ADR 0006). The token lives in the Launcher; this button only
  // asks for the publish, and the two-container split happens on the host side.
  const github = actionCard("Save to GitHub", "Keep this project in a private repo on your account.", () =>
    startPublish(project),
  );

  // Delete sits OUTSIDE the action grid, not as a fifth card in it. The four
  // above are all things you can undo by doing them again; this one is the only
  // control in Claudebox that destroys work, and putting it in the same row of
  // identical cards would make it a misclick away from the one beside it.
  const destroy = el("button", { className: "btn--link destroy", textContent: "Delete this project" });
  destroy.addEventListener("click", async () => {
    try {
      renderDeleteSheet(project, await cb.planDelete(project.slug));
    } catch (err) {
      flash(`Couldn't open ${project.name} to delete it: ${(err as Error).message}`);
    }
  });

  root.append(
    section("light", [
      el("p", { className: "eyebrow", textContent: "This project" }),
      el("div", { className: "grid grid--actions" }, [upload, save, show, preview, github]),
      el("div", { className: "danger" }, [
        el("p", {
          textContent:
            "Finished with this project? Deleting it removes it and everything in it from the sandbox, for good.",
        }),
        destroy,
      ]),
    ]),
  );
  root.append(footer());

  await cb.openSession(project.slug);
}

/**
 * "Save to GitHub" (ADR 0006). Connecting comes first if it has to, and the
 * publish follows from the same click — a Sandbox User asked to save, not to
 * sign in, so the sign-in is a step inside that, never a separate errand.
 */
async function startPublish(project: Project): Promise<void> {
  let status: GithubStatus;
  try {
    status = await cb.githubStatus();
  } catch (err) {
    flash(`Couldn't check your GitHub account: ${(err as Error).message}`);
    return;
  }

  if (!status.configured) {
    flash("This copy of Claudebox has no GitHub sign-in configured, so it can't save there yet.");
    return;
  }
  if (!status.connected) {
    renderGithubConnect(project);
    return;
  }
  await publish(project);
}

async function publish(project: Project): Promise<void> {
  flash(`Saving ${project.name} to GitHub…`);
  try {
    const res = await cb.saveToGithub(project.slug);
    // Naming the branch matters: it is whatever was checked out in the Box, and
    // on a feature branch the repo's front page will not show what was just
    // saved. "(private)" only when Claudebox made the repo — a Project that came
    // in with its own remote publishes back to it, whatever that repo already is.
    flash(
      res.created
        ? `Created ${res.url} (private) — branch ${res.branch}.`
        : `Saved to ${res.url} — branch ${res.branch}.`,
    );
  } catch (err) {
    flash(`Couldn't save to GitHub: ${(err as Error).message}`);
  }
}

/**
 * The GitHub device-flow sheet. Shows the code to type at github.com/login/device
 * and — plainly, because it is the whole cost of this feature — what the sign-in
 * lets Claudebox reach.
 */
function renderGithubConnect(project: Project): void {
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
      await publish(project);
    } catch (err) {
      close();
      flash(`Couldn't connect GitHub: ${(err as Error).message}`);
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
 * "Open a folder from my computer" (ticket 09): picking a folder measures it, then
 * shows the one confirmation sheet. Nothing crosses if the picker is cancelled.
 */
async function startImport(): Promise<void> {
  let listing: ImportListing | undefined;
  try {
    listing = await cb.planImport();
  } catch (err) {
    flash(`Couldn't read that folder: ${(err as Error).message}`);
    return;
  }
  if (!listing) return; // the native picker was cancelled
  renderImportSheet(listing);
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
 * The Export picker (ticket 08). The Launcher builds and renders this list from
 * files it enumerated inside the Box — nothing served from inside the Box
 * decides what the host writes. Everything ticked here is still re-validated in
 * the trusted layer, so this list is a convenience, never the security boundary.
 */
function renderExportPicker(project: Project, listing: ExportListing): void {
  const boxes: HTMLInputElement[] = [];
  const list = el("ul", { className: "files" });

  for (const file of listing.files) {
    const check = el("input", {
      type: "checkbox",
      checked: file.exportable, // exportable files are ticked, so one click still works
      disabled: !file.exportable,
    }) as HTMLInputElement;
    check.dataset.path = file.path;
    check.dataset.size = String(file.size);
    if (file.exportable) boxes.push(check);

    const label = el("label", { className: file.exportable ? "file" : "file blocked" }, [
      check,
      el("span", { className: "name", textContent: file.path }),
      el("span", {
        className: "why",
        // The reason is shown, not hidden: a user whose analysis script does not
        // come out should see why before they commit, not wonder afterwards.
        textContent: file.exportable ? size(file.size) : file.reason ?? "",
      }),
    ]);
    list.append(el("li", {}, [label]));
  }

  const total = el("p", { className: "total" });
  const saveBtn = el("button", { className: "btn", textContent: "Save" }) as HTMLButtonElement;
  const cancel = el("button", { className: "btn--link", textContent: "Cancel" });

  const close = openSheet(
    "Save to my computer",
    [
      el("p", { className: "sub", textContent: `Choose what to save into ${listing.dir}.` }),
      listing.files.length === 0
        ? el("p", { className: "empty", textContent: "This Project has no files yet." })
        : list,
      total,
    ],
    [cancel, saveBtn],
  );

  const selection = () => boxes.filter((b) => b.checked);
  const refresh = () => {
    const picked = selection();
    const bytes = picked.reduce((sum, b) => sum + Number(b.dataset.size), 0);
    const over = bytes > listing.capBytes;
    total.textContent = over
      ? `${picked.length} file(s), ${size(bytes)} — over the ${size(listing.capBytes)} limit. Untick something to save.`
      : `${picked.length} file(s), ${size(bytes)} of ${size(listing.capBytes)}.`;
    total.className = over ? "total over" : "total";
    saveBtn.disabled = over || picked.length === 0;
  };
  for (const b of boxes) b.addEventListener("change", refresh);
  refresh();

  cancel.addEventListener("click", close); // cancelling writes nothing

  saveBtn.addEventListener("click", () =>
    void runOperation({
      button: saveBtn,
      busyLabel: "Saving…",
      close,
      run: () => cb.saveToComputer(project.slug, selection().map((b) => b.dataset.path!)),
      done: (res) =>
        flash(
          res.overCap
            ? `Too big to save: ${size(res.totalBytes)}, and the limit is ${size(res.capBytes)}. Nothing was saved.`
            : saved(res),
        ),
      failed: "Couldn't save",
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

/** "just now" / a local date — the Sandbox User only needs the gist. */
function when(epochMs?: number): string {
  if (!epochMs) return "recently";
  const minutes = Math.round((Date.now() - epochMs) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute(s) ago`;
  return new Date(epochMs).toLocaleString();
}

function renderStarting(): void {
  app().replaceChildren(
    hero([
      el("p", { className: "eyebrow", textContent: "Claudebox" }),
      el("h1", { className: "hero__title", textContent: "Warming the room." }),
      el("p", { className: "lead", textContent: "Getting the sandbox ready. This takes a moment on the first run." }),
    ]),
  );
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

// Wait for the Engine + Box to be ready before the home screen queries Projects
// (they live on a named volume reached through the running Box).
renderStarting();
window.claudebox.onBootstrap((status) => {
  // The Project listing now FAILS rather than reporting an empty Workspace when
  // the Box can't be read, so the first render can reject — say so instead of
  // leaving the Sandbox User on "Warming the room" forever.
  if (status.ok) void renderHome().catch((err: unknown) => renderBootstrapError((err as Error).message));
  else renderBootstrapError(status.message);
});
