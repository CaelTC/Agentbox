/**
 * The per-Project control panel (ticket 04) — its two tabs, the Session tab's
 * own cards, and the two flows they open: Save to GitHub (ADR 0006) and the
 * Delete Project confirmation.
 */
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
  const back = el("button", { className: "back eyebrow" }, [
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

  const sessionTab = el("button", { className: "tab tab--on", role: "tab", textContent: "Session" }) as HTMLButtonElement;
  const filesTab = el("button", { className: "tab", role: "tab", textContent: "Files" }) as HTMLButtonElement;

  // One region under the bar, swapped in place. The tabs are the only navigation
  // in the app that isn't a whole screen, so they change as little as possible:
  // the bar, the Project's name and the way out all stay where they were.
  //
  // `showing` counts the swaps, and a read that lands after one has happened is
  // stale: only the button a read was started FROM is disabled while it runs, so
  // the Sandbox User can click Session mid-read — and a listing that then took
  // the screen back would yank them out of the panel they had just chosen.
  const body = el("div", { className: "tabbed", role: "tabpanel" });
  let showing = 0;
  const select = (tab: HTMLButtonElement, content: Node): void => {
    for (const t of [sessionTab, filesTab]) {
      t.className = t === tab ? "tab tab--on" : "tab";
      t.ariaSelected = String(t === tab);
    }
    showing += 1;
    body.replaceChildren(content);
  };

  // The Files tab reads the Project ONCE, when it is opened, and again only when
  // the Sandbox User asks for it (Refresh) or changes what is there (Add files…).
  // Nothing here is on a timer: every read takes the Box Gate, which is not
  // re-entrant, so a poll would sit on the lock the session itself needs.
  //
  // A failed read is caught HERE rather than left to `runOperation`, because the
  // panel still has to appear: "Add files…" is the only way into a Project, and
  // it opens a host picker that owes the listing nothing. The sentence is the
  // same one either way — `fail` composes every failure in the renderer.
  //
  // Both screens on this tab are drawn from the SAME read — the picker and the
  // delete screen enumerate one Project, and a second enumeration would only be a
  // second thing to keep in step. Which screen the listing becomes is the caller's
  // (`draw`); everything about reading it is here, once.
  const cantRead = `Couldn't read the files in ${project.name}`;
  const readFiles = (
    button: HTMLButtonElement,
    draw: (listing: ExportListing | undefined) => Node,
  ): void => {
    const startedAt = showing;
    void runOperation({
      button,
      run: (): Promise<ExportListing | undefined> =>
        cb.listExportFiles(project.slug).catch((err: unknown) => {
          flash(fail(cantRead, err));
          return undefined;
        }),
      done: (listing) => {
        if (showing === startedAt) select(filesTab, draw(listing));
      },
      // Required by `Operation`, and unreachable here: `run` catches its own
      // failure above, so the promise this hands over never rejects.
      failed: cantRead,
    });
  };

  const loadFiles = (button: HTMLButtonElement, prior?: PriorTicks): void =>
    readFiles(button, (listing) => filesPanel(project, listing, loadFiles, loadDelete, prior));

  // Deleting gets its OWN screen rather than a second verb on the picker.
  // The picker's every control is additive — tick, filter, save, add — and a
  // permanent delete sharing those checkboxes would mean one row of boxes with
  // two buttons under it, one of which destroys work. So they are two screens,
  // and the ticking does not carry between them: nothing arrives here pre-ticked.
  const loadDelete = (button: HTMLButtonElement): void =>
    readFiles(button, (listing) => deletePanel(project, listing, loadDelete, loadFiles));

  sessionTab.addEventListener("click", () => select(sessionTab, sessionPanel(project)));
  filesTab.addEventListener("click", () => loadFiles(filesTab));

  root.append(
    brandBar([
      back,
      el("h1", { className: "brandbar__project", textContent: project.name }),
      el("nav", { className: "tabs", role: "tablist", ariaLabel: `${project.name} panels` }, [
        sessionTab,
        filesTab,
      ]),
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
  // control in Agentbox that destroys work, and putting it in the same row of
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
    flash("This copy of Agentbox has no GitHub sign-in configured, so it can't save there yet.");
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
    // saved. "(private)" only when Agentbox made the repo — a Project that came
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
 * lets Agentbox reach.
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
          "Agentbox asks for access to your repositories so it can create a private one and save this project into it. " +
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
