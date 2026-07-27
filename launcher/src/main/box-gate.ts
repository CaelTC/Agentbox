/**
 * The Box Gate: the Launcher performs ONE Box-touching operation at a time,
 * across the whole main process.
 *
 * The renderer already refuses a second operation while one is in flight, but
 * that is one window's advisory lock over the controls it happens to own.
 * "Update Claudebox" `docker rm -f`s the container, and a second window, a
 * bootstrap, a quit, or any channel reached without a click at all gets to that
 * same container without passing it. What the Sandbox User gets when they cross
 * is the Engine's own words about a container that vanished mid-copy, about an
 * operation they never connected to the button they pressed.
 *
 * So the rule is enforced where the intents actually become effects: the IPC
 * router's `routeViaBox`, plus the two channels that reach the Box without it.
 *
 * QUEUE, not refuse. Refusing would give every caller a second outcome to
 * explain, and the renderer already does that explaining for the buttons it
 * knows; everything gated here is seconds long, so waiting is the honest
 * behaviour and needs no new copy. Order is arrival order.
 *
 * NOT RE-ENTRANT, deliberately. This is a promise chain, so an operation that
 * took the gate again from inside itself would wait for itself forever. It is
 * taken in the router (`viaBox`, and by hand in `openPreview`, `updateBox`,
 * Upload and Project Import), in `bootstrap()` and on quit — never inside a
 * target, which is a rule you can check by grepping the callers of `boxGate`.
 *
 * Nothing held here is unbounded, and nothing is held across a decision a human
 * has to make. Every `exec` into the Box carries a deadline
 * (`BOX_EXEC_TIMEOUT_MS`), because a single command that never returns is not
 * one dead operation but every Box channel dead for the life of the Launcher;
 * the copies are the deliberate exception — a multi-GB Import is slow, and is
 * exactly the thing nothing else may race. The native dialogs are the other
 * half of that rule: the Update confirmation, the Upload file picker and the
 * Import folder picker all open BEFORE the gate is taken and hand it only what
 * was chosen, so a Sandbox User who wandered off mid-browse cannot freeze every
 * Box channel in the Launcher — and a stopped Box is no longer minutes of
 * nothing in front of a picker they just clicked for.
 */

/** The end of the queue: resolves when everything admitted so far has settled. */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `work` once every operation admitted before it has finished, and hold the
 * gate until it settles.
 */
export function boxGate<T>(work: () => Promise<T> | T): Promise<T> {
  // `then(work, work)` — a predecessor that THREW still hands the gate on, and
  // the tail keeps its own failure swallowed, so one operation that fails (a
  // cancelled picker, a `docker cp` onto a full disk) cannot deadlock every
  // operation queued behind it. The rejection still reaches its own caller,
  // through `mine`, exactly as if there had been no gate.
  const mine = tail.then(work, work);
  tail = mine.catch(() => undefined);
  return mine;
}
