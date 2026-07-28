/**
 * The furniture every screen is built out of: the brand band, the one-line bar
 * that replaces it on the working screens, a section, the notice strip, the
 * footer, and the action card.
 */
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
 * housekeeping. GitHub and "Agentbox itself" used to be two consecutive light
 * bands with full section weight, which between them took more of the home
 * screen than the Projects did. They are the same two controls here, at the size
 * of what they are: things you touch once a month, at the bottom, on one line.
 */
function footer(utilities: Node[] = []): HTMLElement {
  return el("footer", { className: "footer" }, [
    el("div", { className: "container footer__row" }, [
      el("span", { textContent: "Agentbox runs on your computer. Built in British Columbia." }),
      ...utilities,
    ]),
  ]);
}

/**
 * One action, its plain-language consequence, and the click that does it. A
 * shape, not a promise about where the click goes: the home screen's tiles open
 * a Project or a sheet and touch nothing, while the panel's cards reach the Box.
 * The card is handed to its own handler for the latter — those run as operations,
 * and an operation disables the control that started it.
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
