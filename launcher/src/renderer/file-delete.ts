/**
 * The Files tab's other screen: deleting files and folders inside a Project,
 * and the one confirmation between a click here and an `rm` inside the Box.
 */
/**
 * The delete screen: the same Project, the same two panes, and one verb — the
 * mirror of the picker in files.ts rather than a mode inside it.
 *
 * Three things differ from the picker, and each of them is the difference between
 * carrying a copy out and destroying the only one:
 *
 *   Nothing starts ticked. The picker opens with everything ticked because "save
 *   all of it" is one click and costs nothing; the same default here would put a
 *   button reading "Delete 41 files" under someone's cursor the moment the screen
 *   appeared.
 *
 *   Nothing is greyed out. `exportable` is a rule about what may leave the Box —
 *   a 300MB model file is refused there and is exactly the thing someone comes
 *   here to remove. Deleting is not exporting, so that rule does not apply.
 *
 *   A FOLDER is a target of its own, taken from the tree on the left, and it goes
 *   with everything under it (the spec's rule: folders delete with their contents
 *   rather than refusing when they aren't empty). That is the click worth the
 *   type-the-name gate — see `renderFileDeleteSheet`.
 *
 * `.git` and the Project's own marker never appear here because the Box-side
 * listing prunes them before this screen ever sees a path, and the trusted layer
 * refuses them again on the way back (core/delete.ts). What is ticked here is a
 * request; `boxDeleteFiles` re-enumerates the Project and re-checks every path
 * before an `rm` runs.
 */
function deletePanel(
  project: Project,
  listing: ExportListing | undefined,
  reload: (button: HTMLButtonElement) => void,
  backToFiles: (button: HTMLButtonElement) => void,
): HTMLElement {
  const files = listing?.files ?? [];
  const paths = files.map((f) => f.path);
  const selected = new Set<string>(); // deliberately empty — see above
  let folder = "";
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
  const back = el("button", { className: "btn--link", textContent: "Back to saving files" }) as HTMLButtonElement;
  const removeBtn = el("button", { className: "btn" }) as HTMLButtonElement;
  const folderBtn = el("button", { className: "btn--link destroy" }) as HTMLButtonElement;

  // Whatever the screen shows next, it shows against a fresh listing: a delete
  // that half-succeeded is exactly the case where the stale list on screen is
  // wrong, and the honest thing is to go and look again.
  const afterDelete = (button: HTMLButtonElement) => (res: FileDeleteResult) => {
    const gone =
      res.deleted.length === 0
        ? "Nothing was deleted."
        : `Deleted ${res.fileCount} file(s), ${size(res.totalBytes)}.`;
    // The first refusal, in the words the trusted layer used. Not swallowed and
    // not summarised into "some files": a file that would not go is the thing the
    // Sandbox User has to know about, and the count says whether there are more.
    const kept = res.failed[0];
    flash(
      kept
        ? `${gone} ${res.failed.length} couldn't be deleted — ${kept.path}: ${kept.reason}`
        : gone,
    );
    reload(button);
  };

  function drawTree(): void {
    tree.replaceChildren();
    for (const dir of ["", ...fileFolders(paths)]) {
      const row = el("button", {
        className: dir === folder ? "tree__row tree__row--on" : "tree__row",
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
      }) as HTMLInputElement;
      check.addEventListener("change", () => {
        if (check.checked) selected.add(file.path);
        else selected.delete(file.path);
        drawTotal();
      });
      list.append(
        el("li", {}, [
          el("label", { className: "file" }, [
            check,
            el("span", {
              className: "name",
              textContent: folder === "" ? file.path : file.path.slice(folder.length + 1),
            }),
            // The size, always — including for files the picker refuses to
            // export, whose "why" is about saving and says nothing about this.
            el("span", { className: "why", textContent: size(file.size) }),
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
              ? "Couldn't read what's in this project. Go back and try again."
              : query
                ? "Nothing here matches that."
                : "Nothing in this folder.",
          }),
        ]),
      );
    }
    drawTotal();
  }

  function drawTotal(): void {
    // No cap: the Export ceiling is about what crosses onto the host, and nothing
    // crosses here. Infinity keeps the one selection helper both screens share.
    const picked = selectionTotal(files, selected, Number.POSITIVE_INFINITY);
    total.textContent = picked.count === 0 ? "" : `${size(picked.bytes)} selected`;
    removeBtn.textContent =
      picked.count === 1 ? "Delete 1 file" : `Delete ${picked.count} files`;
    removeBtn.disabled = picked.count === 0;

    // The folder button names the folder it will take, because "Delete folder"
    // beside a tree you may have clicked minutes ago is a sentence about nothing.
    const here = folderTotal(files, folder);
    folderBtn.textContent = `Delete the ${folder.slice(folder.lastIndexOf("/") + 1)} folder (${here.count} file(s))`;
    folderBtn.hidden = folder === "" || here.count === 0;
  }

  filter.addEventListener("input", () => {
    query = filter.value;
    drawFiles();
  });

  back.addEventListener("click", () => backToFiles(back));

  removeBtn.addEventListener("click", () => {
    const picked = selectionTotal(files, selected, Number.POSITIVE_INFINITY);
    renderFileDeleteSheet(
      project,
      { paths: [...selected], count: picked.count, bytes: picked.bytes },
      afterDelete(removeBtn),
    );
  });

  folderBtn.addEventListener("click", () => {
    const here = folderTotal(files, folder);
    renderFileDeleteSheet(
      project,
      { paths: [folder], count: here.count, bytes: here.bytes, folder },
      afterDelete(folderBtn),
    );
  });

  drawTree();
  drawFiles();

  return el("div", {}, [
    el("p", { className: "eyebrow", textContent: "Delete files from this project" }),
    el("div", { className: "two" }, [
      tree,
      el("div", {}, [
        el("div", { className: "tools" }, [filter, back]),
        list,
        ...(listing ? [el("div", { className: "bar" }, [removeBtn, folderBtn, total])] : []),
      ]),
    ]),
    el("div", { className: "danger" }, [
      el("p", {
        textContent:
          "Deleting is permanent. There's no trash in the sandbox, and copies you already saved to your computer aren't touched.",
      }),
    ]),
  ]);
}

/**
 * The one confirmation between a click on the delete screen and an `rm` inside
 * the Box. Both shapes of it: a ticked set of files, and a folder.
 *
 * The friction SCALES, which is the settled decision this sheet exists to carry
 * out. Ticking three files is already a deliberate act repeated three times, and
 * making that person type a name as well would only teach them to type it without
 * reading — so a file selection gets a plain confirm. A folder is ONE click that
 * can take forty-one files, most of which the Sandbox User never looked at, so it
 * takes the same type-the-name gate as deleting a Project, through the very same
 * `normalize` rule (core/delete.ts, `confirmsProjectName`).
 *
 * Neither shape can arrive at the Box unconfirmed: the button starts disabled in
 * the folder case, and in both cases the trusted layer re-enumerates, re-checks
 * containment, and — for a folder — re-checks the typed name before removing
 * anything. What is enforced here is only what the screen is willing to ASK for.
 */
function renderFileDeleteSheet(
  project: Project,
  target: { paths: string[]; count: number; bytes: number; folder?: string },
  done: (res: FileDeleteResult) => void,
): void {
  const name = target.folder === undefined ? undefined : folderName(target.folder);

  const remove = el("button", { className: "btn", textContent: "Delete forever" }) as HTMLButtonElement;
  const cancel = el("button", { className: "btn--link", textContent: "Cancel" });

  const confirmName =
    name === undefined
      ? undefined
      : (el("input", {
          type: "text",
          placeholder: name,
          // A password manager or an autofilled name would defeat the point.
          autocomplete: "off",
          spellcheck: false,
        }) as HTMLInputElement);

  const close = openSheet(
    name === undefined ? "Delete these files" : "Delete this folder",
    [
      el("p", {
        className: "sub",
        textContent: name === undefined ? `${target.count} file(s)` : `${target.folder}/`,
      }),
      el("p", {
        className: "total",
        textContent:
          name === undefined
            ? `${size(target.bytes)} — all of it deleted.`
            : `${target.count} file(s), ${size(target.bytes)} — the folder and everything in it.`,
      }),
      el("p", {
        textContent:
          "This can't be undone. There's no trash in the sandbox, and the copy in here is the only one.",
      }),
      el("p", {
        className: "sub",
        textContent: "Anything you already saved to your computer stays where it is.",
      }),
      ...(confirmName
        ? [
            el("label", { className: "confirm" }, [
              el("span", { textContent: `Type ${name} below to confirm.` }),
              confirmName,
            ]),
          ]
        : []),
    ],
    [cancel, remove],
  );

  if (confirmName && name !== undefined) {
    const refresh = () => {
      // The renderer's copy of the rule enables the button and nothing more; the
      // trusted layer re-checks the typed name before anything is removed.
      remove.disabled = normalize(confirmName.value) !== normalize(name);
    };
    confirmName.addEventListener("input", refresh);
    refresh();
  }

  cancel.addEventListener("click", close); // cancelling deletes nothing

  remove.addEventListener("click", () =>
    void runOperation({
      button: remove,
      busyLabel: "Deleting…",
      close,
      run: () => cb.deleteFiles(project.slug, target.paths, confirmName?.value),
      done,
      failed: "Couldn't delete",
    }),
  );

  confirmName?.focus();
}
