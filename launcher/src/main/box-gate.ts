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
 * target.
 *
 * That used to be a rule you kept by grepping the callers, and the cost of
 * forgetting it is the worst failure this file has: not one broken operation but
 * every Box channel dead, silently, for the life of the Launcher, with nothing on
 * screen but a button that never comes back. So it is now enforced (`insideGate`)
 * — a re-entrant take THROWS, on the spot, naming itself. A caught deadlock is a
 * bug report; an uncaught one is a Sandbox User force-quitting the app.
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

import { AsyncLocalStorage } from "node:async_hooks";

/** The end of the queue: resolves when everything admitted so far has settled. */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Set for exactly as long as an operation is holding the gate, and inherited by
 * everything that operation awaits — which is what makes "did this call come
 * from INSIDE the running operation?" answerable at all.
 *
 * A plain boolean cannot answer it: it would be true for the whole time the gate
 * is held, so it could not tell a re-entrant take from the ordinary case this
 * gate exists for — a second IPC call arriving while the first is in flight,
 * which must queue and not throw. Those two are distinguished only by async
 * context: a re-entrant take inherits the holder's, an IPC call from Electron
 * arrives with its own.
 */
const insideGate = new AsyncLocalStorage<true>();

/**
 * Run `work` once every operation admitted before it has finished, and hold the
 * gate until it settles.
 *
 * Throws, synchronously, if called from inside an operation that already holds
 * the gate — see the re-entrancy note above. Synchronously and not as a rejected
 * promise so the stack points at the offending call rather than at the queue.
 */
export function boxGate<T>(work: () => Promise<T> | T): Promise<T> {
  if (insideGate.getStore()) {
    throw new Error(
      "Box Gate re-entered: an operation holding the gate took it again, which would " +
        "deadlock every Box channel. Call the target directly — it is already alone.",
    );
  }

  // `then(work, work)` — a predecessor that THREW still hands the gate on, and
  // the tail keeps its own failure swallowed, so one operation that fails (a
  // cancelled picker, a `docker cp` onto a full disk) cannot deadlock every
  // operation queued behind it. The rejection still reaches its own caller,
  // through `mine`, exactly as if there had been no gate.
  const mine = tail.then(
    () => insideGate.run(true, work),
    () => insideGate.run(true, work),
  );
  tail = mine.catch(() => undefined);
  return mine;
}
