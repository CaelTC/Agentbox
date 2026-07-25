/**
 * The home screen (ticket 05) and the in-Project session view (tickets 04/06/07/08).
 * Pure DOM against the narrow `window.claudebox` bridge — no Node, Docker, or
 * shell access here.
 */
const cb = window.claudebox;

const app = () => document.getElementById("app")!;

function el(tag: string, props: Record<string, unknown> = {}, children: (Node | string)[] = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

async function renderHome(): Promise<void> {
  const [projects, templates] = await Promise.all([cb.listProjects(), cb.listTemplates()]);
  const root = app();
  root.replaceChildren();
  root.append(el("h1", { textContent: "Claudebox" }));
  root.append(el("p", { className: "sub", textContent: "Pick a Project, or start something new." }));

  // Starter Templates — so the user never faces a blank chat (ticket 08).
  root.append(el("h2", { textContent: "Start something new" }));
  const templateGrid = el("div", { className: "grid" });
  for (const t of templates) {
    templateGrid.append(templateCard(t));
  }
  root.append(templateGrid);

  // A blank Project.
  const nameInput = el("input", { type: "text", placeholder: "Name your Project…" }) as HTMLInputElement;
  const createBtn = el("button", { textContent: "Create blank Project" });
  createBtn.addEventListener("click", async () => {
    if (!nameInput.value.trim()) return;
    const project = await cb.createProject(nameInput.value.trim());
    await openProject(project);
  });
  root.append(el("div", { className: "new-project" }, [nameInput, createBtn]));

  // Existing Projects (ticket 05).
  root.append(el("h2", { textContent: "Your Projects" }));
  if (projects.length === 0) {
    root.append(el("p", { className: "empty", textContent: "No Projects yet — create one above." }));
  } else {
    const list = el("ul", { className: "projects" });
    for (const p of projects) {
      const open = el("button", { textContent: p.name });
      open.addEventListener("click", () => openProject(p));
      list.append(el("li", {}, [open]));
    }
    root.append(list);
  }
}

function templateCard(t: StarterTemplate): HTMLElement {
  const card = el("button", { className: "card" }, [
    el("strong", { textContent: t.title }),
    el("span", { textContent: t.description }),
  ]);
  card.addEventListener("click", async () => {
    const project = await cb.createFromTemplate(t.id);
    await openProject(project);
  });
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

  const back = el("button", { className: "link", textContent: "← Projects" });
  back.addEventListener("click", () => void renderHome());

  const upload = el("button", { textContent: "Upload files" });
  upload.addEventListener("click", async () => {
    const copied = await cb.upload(project.slug);
    if (copied.length) flash(`Uploaded ${copied.length} file(s) into ${project.name}.`);
  });

  const preview = el("button", { textContent: "Preview" });
  preview.addEventListener("click", async () => {
    const res = await cb.openPreview();
    flash(res.opened ? `Opened ${res.url}` : "Nothing is being served yet — ask Claude to start a server.");
  });

  // Export (tickets 07/08): carry the Project's documents onto the real MacBook.
  // Both of these reach into the Box, so both can fail before they show anything
  // — an unreported rejection would leave the button looking simply dead.
  const save = el("button", { textContent: "Save to my Mac" });
  save.addEventListener("click", async () => {
    try {
      renderExportPicker(project, await cb.listExportFiles(project.slug));
    } catch (err) {
      flash(`Couldn't open ${project.name} to save it: ${(err as Error).message}`);
    }
  });

  const show = el("button", { textContent: "Show files" });
  show.addEventListener("click", async () => {
    try {
      const res = await cb.showSavedFiles(project.slug);
      flash(
        res.opened
          ? `Last saved ${when(res.lastSaved)}.`
          : `Nothing saved yet — “Save to my Mac” puts this Project in ${res.dir}.`,
      );
    } catch (err) {
      flash(`Couldn't show the saved files: ${(err as Error).message}`);
    }
  });

  // Re-open the Chrome window on the same live session (still alive in tmux).
  const reopen = el("button", { textContent: "Reopen terminal" });
  reopen.addEventListener("click", () => void cb.openSession(project.slug));

  root.append(
    el("div", { className: "toolbar" }, [
      back,
      el("strong", { textContent: project.name }),
      upload,
      save,
      show,
      preview,
      reopen,
    ]),
  );
  root.append(
    el("p", { className: "sub", textContent: `${project.name} is open in a Claude session window.` }),
  );

  await cb.openSession(project.slug);
}

/**
 * The Export picker (ticket 08). The Launcher builds and renders this list from
 * files it enumerated inside the Box — nothing served from inside the Box
 * decides what the host writes. Everything ticked here is still re-validated in
 * the trusted layer, so this list is a convenience, never the security boundary.
 */
function renderExportPicker(project: Project, listing: ExportListing): void {
  const dialog = el("div", { className: "sheet" }) as HTMLDivElement;
  const panel = el("div", { className: "panel" });

  panel.append(el("h2", { textContent: "Save to my Mac" }));
  panel.append(
    el("p", {
      className: "sub",
      textContent: `Choose what to save into ${listing.dir}.`,
    }),
  );

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

  if (listing.files.length === 0) {
    panel.append(el("p", { className: "empty", textContent: "This Project has no files yet." }));
  } else {
    panel.append(list);
  }

  const total = el("p", { className: "total" });
  const saveBtn = el("button", { textContent: "Save" }) as HTMLButtonElement;
  const cancel = el("button", { className: "link", textContent: "Cancel" });

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

  cancel.addEventListener("click", () => dialog.remove()); // cancelling writes nothing

  saveBtn.addEventListener("click", async () => {
    const pick = selection().map((b) => b.dataset.path!);
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const res = await cb.saveToMac(project.slug, pick);
      dialog.remove();
      flash(
        res.overCap
          ? `Too big to save: ${size(res.totalBytes)}, and the limit is ${size(res.capBytes)}. Nothing was saved.`
          : `Saved ${res.saved} file(s) to ${res.dir}.`,
      );
    } catch (err) {
      dialog.remove();
      flash(`Couldn't save: ${(err as Error).message}`);
    }
  });

  panel.append(total);
  panel.append(el("div", { className: "actions" }, [cancel, saveBtn]));
  dialog.append(panel);
  document.body.append(dialog);
}

/** Sizes for a Sandbox User: no bytes, no decimals below a gigabyte. */
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

function flash(message: string): void {
  const note = el("div", { className: "flash", textContent: message });
  document.body.append(note);
  setTimeout(() => note.remove(), 3500);
}

function renderStarting(): void {
  const root = app();
  root.replaceChildren(
    el("h1", { textContent: "Claudebox" }),
    el("p", { className: "sub", textContent: "Starting up — getting the sandbox ready…" }),
  );
}

function renderBootstrapError(message: string): void {
  const root = app();
  root.replaceChildren(
    el("h1", { textContent: "Claudebox" }),
    el("p", { className: "error", textContent: message }),
  );
}

// Wait for the Engine + Box to be ready before the home screen queries Projects
// (they live on a named volume reached through the running Box).
renderStarting();
window.claudebox.onBootstrap((status) => {
  if (status.ok) void renderHome();
  else renderBootstrapError(status.message);
});
