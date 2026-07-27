/**
 * The Box Gate: the Launcher performs ONE Box-touching operation at a time,
 * across the whole main process.
 *
 * The renderer already refuses a second operation while one is in flight, but
 * that is one window's advisory lock over the four buttons it happens to know
 * about. "Update Claudebox" `docker rm -f`s the container, and every other
 * Box-touching channel — Upload, Save to GitHub, create a Project, the export
 * listing, the delete plan, opening a session — reaches that same container
 * without passing the renderer's lock. What the Sandbox User gets when they
 * cross is the Engine's own words about a container that vanished mid-copy,
 * about an operation they never connected to the button they pressed.
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
 * took the gate again from inside itself would wait for itself forever. The
 * gate is taken in exactly two places — the router's registrars and
 * `bootstrap()` — and never inside a target, which is a rule you can check by
 * grepping the callers of `exclusive`.
 */

/** The end of the queue: resolves when everything admitted so far has settled. */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `work` once every operation admitted before it has finished, and hold the
 * gate until it settles.
 */
export function exclusive<T>(work: () => Promise<T> | T): Promise<T> {
  // `then(work, work)` — a predecessor that THREW still hands the gate on, and
  // the tail keeps its own failure swallowed, so one operation that fails (a
  // cancelled picker, a `docker cp` onto a full disk) cannot deadlock every
  // operation queued behind it. The rejection still reaches its own caller,
  // through `mine`, exactly as if there had been no gate.
  const mine = tail.then(work, work);
  tail = mine.catch(() => undefined);
  return mine;
}
