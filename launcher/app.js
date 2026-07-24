"use strict";
/**
 * The home screen (ticket 05) and the in-Project session view (tickets 04/06/07/08).
 * Pure DOM against the narrow `window.claudebox` bridge — no Node, Docker, or
 * shell access here.
 */
const cb = window.claudebox;
const app = () => document.getElementById("app");
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children)
        node.append(c);
    return node;
}
async function renderHome() {
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
    const nameInput = el("input", { type: "text", placeholder: "Name your Project…" });
    const createBtn = el("button", { textContent: "Create blank Project" });
    createBtn.addEventListener("click", async () => {
        if (!nameInput.value.trim())
            return;
        const project = await cb.createProject(nameInput.value.trim());
        await openProject(project);
    });
    root.append(el("div", { className: "new-project" }, [nameInput, createBtn]));
    // Existing Projects (ticket 05).
    root.append(el("h2", { textContent: "Your Projects" }));
    if (projects.length === 0) {
        root.append(el("p", { className: "empty", textContent: "No Projects yet — create one above." }));
    }
    else {
        const list = el("ul", { className: "projects" });
        for (const p of projects) {
            const open = el("button", { textContent: p.name });
            open.addEventListener("click", () => openProject(p));
            list.append(el("li", {}, [open]));
        }
        root.append(list);
    }
}
function templateCard(t) {
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
async function openProject(project) {
    const root = app();
    root.replaceChildren();
    const back = el("button", { className: "link", textContent: "← All Projects" });
    back.addEventListener("click", () => void renderHome());
    const upload = el("button", { textContent: "Upload files" });
    upload.addEventListener("click", async () => {
        const copied = await cb.upload(project.slug);
        if (copied.length)
            flash(`Uploaded ${copied.length} file(s) into ${project.name}.`);
    });
    const preview = el("button", { textContent: "Preview" });
    preview.addEventListener("click", async () => {
        const res = await cb.openPreview();
        flash(res.opened ? `Opened ${res.url}` : "Nothing is being served yet — ask Claude to start a server.");
    });
    root.append(el("div", { className: "toolbar" }, [back, el("strong", { textContent: project.name }), upload, preview]));
    const termEl = el("div", { className: "terminal", id: "terminal" });
    root.append(termEl);
    // Attach the interactive Claude session (ticket 04). xterm.js is bundled with
    // the packaged app and exposed as window.Terminal.
    const term = new window.Terminal({ convertEol: true, fontSize: 13 });
    term.open(termEl);
    cb.onSessionData((chunk) => term.write(chunk));
    term.onData((data) => cb.sendSessionInput(data));
    await cb.openSession(project.slug);
}
function flash(message) {
    const note = el("div", { className: "flash", textContent: message });
    document.body.append(note);
    setTimeout(() => note.remove(), 3500);
}
function renderStarting() {
    const root = app();
    root.replaceChildren(el("h1", { textContent: "Claudebox" }), el("p", { className: "sub", textContent: "Starting up — getting the sandbox ready…" }));
}
function renderBootstrapError(message) {
    const root = app();
    root.replaceChildren(el("h1", { textContent: "Claudebox" }), el("p", { className: "error", textContent: message }));
}
// Wait for the Engine + Box to be ready before the home screen queries Projects
// (they live on a named volume reached through the running Box).
renderStarting();
window.claudebox.onBootstrap((status) => {
    if (status.ok)
        void renderHome();
    else
        renderBootstrapError(status.message);
});
