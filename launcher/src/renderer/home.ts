/**
 * The home screen (ticket 05): the Projects, the two ways to start one, and the
 * housekeeping in the footer.
 */
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
      el("strong", { className: "brandbar__name", textContent: "Agentbox" }),
      el("p", {
        className: "brandbar__lead",
        textContent: "A sealed room. Nothing leaves it unless you carry it out.",
      }),
    ]),
  );

  if (notice) root.append(noticeStrip(notice));

  // The Codex banner's place, held now and filled in later if the launch's
  // version check has anything to offer — see `codexNotice`, which is started at
  // the foot of this function and never waited on.
  const codexSlot = el("div");
  root.append(codexSlot);

  // The Projects (ticket 05) are the home screen now, first and at full width:
  // resuming yesterday's work is what the Launcher is opened for, and it used to
  // sit two bands down, behind a statement of what Agentbox is.
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

  // Started, not awaited: the answer can be minutes behind this paint, and the
  // Projects are what the Launcher was opened for.
  void codexNotice(codexSlot);
}

/**
 * "Codex update available (0.9.1)", with the button that installs it — the one
 * agent update Agentbox asks about instead of just doing (backlog:
 * codex-update-notify). Claude Code is refreshed on every launch because
 * `claude update` is a ~1s no-op when there is nothing new; `npm install -g
 * @openai/codex` costs its ~15s every time, so this one is offered rather than
 * spent, and the launch only pays for the two version reads behind it.
 *
 * Awaited by nobody. The check runs behind the launch's own `claude update` at
 * the Box Gate, so a home screen that waited for this would sit on an empty
 * page for as long as that took — and by the time the answer lands the Sandbox
 * User may be inside a Project, which is what `isConnected` asks: the slot is
 * still in the document only while the home screen it was drawn into is.
 */
async function codexNotice(slot: HTMLElement): Promise<void> {
  // Never a failure on screen: a check that could not run is a Launcher with
  // nothing to say about Codex, which is exactly what it says by staying empty.
  const version = await cb.codexUpdate().catch(() => undefined);
  if (!version || !slot.isConnected) return;

  const update = el("button", {
    className: "btn--link",
    textContent: "Update Codex",
  }) as HTMLButtonElement;

  const strip = noticeStrip(`Codex update available (${version}).`, [update]);
  slot.append(strip);

  update.addEventListener("click", () =>
    void runOperation({
      button: update,
      busyLabel: "Updating…",
      run: () => cb.updateCodex(),
      // The banner goes on success ONLY. A failed update leaves it up, because
      // the update is still there to be had and the strip is the only way back
      // to it short of relaunching.
      done: (message) => {
        strip.remove();
        flash(message);
      },
      failed: "Couldn't update Codex",
    }),
  );
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

  // Closed from `done` rather than by handing `close` to the operation, which
  // would dismiss the sheet on either outcome: the other sheets that do that are
  // confirmations with nothing to retype, and this one holds a typed name. A
  // refused create leaves the sheet up with the name still in the field.
  createBtn.addEventListener("click", () =>
    void runOperation({
      button: createBtn,
      busyLabel: "Creating…",
      run: () => cb.createProject(nameInput.value.trim()),
      done: (project) => {
        close();
        return openProject(project);
      },
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
 * "Update Agentbox" — Refresh on Launch (ADR 0002) on a button, for the gap it
 * leaves: a fix ships, and a Sandbox User who never quits the Launcher stays on
 * last week's Box with no way to ask for the new one.
 *
 * Home screen only, and a footer link rather than a band of its own. Updating
 * restarts the sandbox and closes every open Claude session, which is not a
 * thing to put a click away from a Project tile — and it is nobody's reason for
 * opening the Launcher.
 */
function updateLink(): HTMLButtonElement {
  const update = el("button", { className: "btn--link", textContent: "Update Agentbox" }) as HTMLButtonElement;

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
      failed: "Couldn't update Agentbox",
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
