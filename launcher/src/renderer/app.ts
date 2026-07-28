/**
 * The launch screen and the bootstrap wiring — the LAST of the renderer's
 * classic scripts, and the only one that runs anything as it loads. Everything
 * it calls is declared by the scripts index.html lists ahead of it.
 */
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
      el("p", { className: "eyebrow", textContent: "Agentbox" }),
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
      el("p", { className: "eyebrow", textContent: "Agentbox" }),
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
window.agentbox.onBootstrap((status) => {
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
