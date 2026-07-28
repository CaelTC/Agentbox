/**
 * The Files tab (tickets 07/08): everything in one Project, what may be carried
 * out to the Sandbox User's computer, and what has already been.
 */
/**
 * What a rebuilt Files tab needs to know about the one it replaces: which paths
 * were ticked, and which paths it had at all — the second is what makes a file
 * that appeared since then recognisable as new. See `carriedSelection`.
 */
interface PriorTicks {
  readonly selected: ReadonlySet<string>;
  readonly known: ReadonlySet<string>;
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
 *
 * `listing` is absent when the read failed, and the panel is still built: "Add
 * files…" is the ONLY way into a Project, it opens a picker on the host, and it
 * must not be reachable only through a Box read that can fail. What a failed read
 * costs is what the Launcher genuinely doesn't know — the list, the totals, and
 * the landing folder's name — never the way in or the way to try again.
 */
function filesPanel(
  project: Project,
  listing: ExportListing | undefined,
  reload: (button: HTMLButtonElement, prior?: PriorTicks) => void,
  openDelete: (button: HTMLButtonElement) => void,
  prior?: PriorTicks,
): HTMLElement {
  const files = listing?.files ?? [];
  const paths = files.map((f) => f.path);
  const selected = carriedSelection(files, prior);
  let folder = ""; // the whole Project
  let query = "";

  const tree = el("ul", { className: "tree" });
  const list = el("ul", { className: "files" });
  const total = el("span", { className: "total" });
  const filter = el("input", {
    type: "search",
    placeholder: "Filter files…",
    ariaLabel: "Filter files",
    autocomplete: "off",
  }) as HTMLInputElement;
  const add = el("button", { className: "btn--link", textContent: "Add files…" }) as HTMLButtonElement;
  const refresh = el("button", { className: "btn--link", textContent: "Refresh" }) as HTMLButtonElement;
  const saveBtn = el("button", { className: "btn" }) as HTMLButtonElement;
  const openSaved = el("button", { className: "btn--link", textContent: "Open that folder" }) as HTMLButtonElement;
  const deleteLink = el("button", {
    className: "btn--link destroy",
    textContent: "Delete files…",
  }) as HTMLButtonElement;
  deleteLink.addEventListener("click", () => openDelete(deleteLink));

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
    const shown = files.filter((f) => inFolder(f.path, folder) && matchesFilter(f.path, query));
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
            textContent: !listing
              ? "Couldn't read what's in this project. Refresh to try again — you can still add files."
              : query
                ? "Nothing here matches that."
                : "Nothing in this folder yet.",
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
    if (!listing) return; // no cap to measure against, and no action bar on screen
    const picked = selectionTotal(files, selected, listing.capBytes);
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
        // Adding is not re-reading: the ticks the Sandbox User already made go
        // across to the panel that replaces this one, and only what wasn't here
        // before arrives ticked.
        reload(add, { selected, known: new Set(paths) });
      },
      failed: "Couldn't add those files",
    }),
  );

  saveBtn.addEventListener("click", () =>
    void runOperation({
      button: saveBtn,
      busyLabel: "Saving…",
      run: () => cb.saveToComputer(project.slug, [...selected]),
      done: (res) => {
        flash(
          res.overCap
            ? `Too big to save: ${size(res.totalBytes)}, and the limit is ${size(res.capBytes)}. Nothing was saved.`
            : saved(res),
        );
        // The boxes stay live while "Saving…" runs, and `runOperation` puts back
        // the label and the enabled state it captured BEFORE the save — so a tick
        // changed mid-save would otherwise leave a button reading the old count
        // that saves the new one. Redrawing from the selection settles both.
        drawTotal();
      },
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
        // Saving needs a selection and a cap to measure it against; both come
        // from the listing, so a failed read leaves the bar off rather than
        // offering a button that could only refuse.
        ...(listing ? [el("div", { className: "bar" }, [saveBtn, total])] : []),
      ]),
    ]),
    // "Show saved files" was a card that answered a question with a toast. The
    // answer is on screen now, and the button only opens the folder. The folder's
    // name is the Box's to tell, so this line waits for a listing too.
    ...(listing
      ? [
          el("div", { className: "saved" }, [
            el("span", { textContent: `Saved copies land in ${listing.dir}.` }),
            openSaved,
          ]),
        ]
      : []),
    // The way to the delete screen, in the same `.danger` slot below the rule
    // that "Delete this project" occupies on the Session tab — and for the same
    // reason. Everything above this line is additive and repeatable; this is the
    // one control on the tab that leads somewhere work can be destroyed, so it
    // must not sit among the controls that carry files about. Absent when the
    // read failed: there is nothing to choose from, and the screen it opens
    // would only be the same failure a second time.
    ...(listing && files.length > 0
      ? [
          el("div", { className: "danger" }, [
            el("p", {
              textContent:
                "Finished with something in here? Deleting a file removes it from the sandbox for good.",
            }),
            deleteLink,
          ]),
        ]
      : []),
  ]);
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
  return `${done} ${res.unmarked} couldn't be marked as coming from Agentbox — open those with the same care as an email attachment.`;
}
