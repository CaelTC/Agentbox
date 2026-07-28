import { updateMessage, type RefreshResult } from "../core/refresh";
import type { OnStep } from "../core/startup";
import type { BootstrapStatus } from "../shared/api";
import { boxGate } from "./box-gate";
import { homeListedProjects } from "./ipc";
import { hostBoxDefinitionDir } from "./paths";
import { refreshOnLaunch } from "./refresh-runner";
import { ensureBoxReady, ensureEngine, removeBoxContainer, updateClaudeCode } from "./session";

/**
 * Getting the Engine and the Box running BEFORE the home screen queries
 * Projects. In its own module, and behind an injectable seam, for the same
 * reason `updateAgentbox` is: what matters here is a SEQUENCE — which turn at
 * the gate, which status, in what order — and none of that is assertable while
 * it lives inside an `app.whenReady()` closure over a BrowserWindow.
 */
export interface BootstrapSteps {
  ensureEngine(onStep: OnStep): Promise<void>;
  /** The same pull + integrity gate + conditional build as Update Agentbox. */
  refresh(onStep: OnStep): Promise<RefreshResult>;
  removeBoxContainer(): Promise<void>;
  ensureBoxReady(onStep: OnStep): Promise<void>;
  updateClaudeCode(): Promise<boolean>;
  /** Resolves once the home screen has been handed its Projects (see ipc.ts). */
  homeListed: Promise<void>;
}

const launchSteps: BootstrapSteps = {
  ensureEngine,
  refresh: refreshOnLaunch,
  removeBoxContainer,
  ensureBoxReady: (onStep) => ensureBoxReady(hostBoxDefinitionDir(), onStep),
  updateClaudeCode,
  homeListed: homeListedProjects,
};

/** How long a window that never asks for its Projects may hold up the update. */
const HOME_LISTING_GRACE_MS = 5_000;

/**
 * Order matters: the Engine must be up before Refresh-on-Launch can build, and
 * the Box must be running before Projects (which live on the named volume) can
 * be listed or created. Status is reported to the renderer, not swallowed.
 *
 * Held under the Box Gate, because Refresh on Launch is an Update Agentbox that
 * nobody pressed: the home screen is already loaded and clickable while this
 * runs (that is what `did-finish-load` means), and its first `listProjects` —
 * or an impatient "Update Agentbox" — would otherwise reach a container this
 * is in the middle of removing and recreating. Taking the gate turns that race
 * into a queue. Nothing in here goes back through the router, so there is no
 * way for the gate to wait on itself.
 *
 * TWO turns at the gate, not one. The Box being ready is what the home screen
 * waits on; the Claude Code update is a separate operation, queued behind the
 * home screen's own first listing, so the Projects appear as soon as the Box is
 * up. Held as one, `claude update` (up to `timeout 180`) sat in front of the
 * home screen on every single launch.
 *
 * Every slow step says what it is doing (`working`), because the alternative —
 * one motionless screen for the several minutes a first build takes — is
 * indistinguishable from a Launcher that has hung (issue #27). Those are the
 * only statuses that may repeat: an `ok` is what makes the renderer draw the
 * home screen, so the honest number of THOSE is still exactly one.
 */
export async function bootstrap(
  send: (status: BootstrapStatus) => void,
  steps: BootstrapSteps = launchSteps,
): Promise<void> {
  const working: OnStep = (message) => send({ phase: "working", message });
  try {
    let refresh: RefreshResult | undefined;
    await boxGate(async () => {
      await steps.ensureEngine(working);
      refresh = await steps.refresh(working); // pull + rebuild only if changed
      if (refresh.action === "error" || refresh.action === "blocked") {
        // Non-fatal for a machine that already has an image; fatal only if there's
        // nothing to run, which ensureBoxReady surfaces below. A `blocked` is the
        // integrity gate declining an untrusted definition — the one outcome that
        // must never pass unlogged.
        console.warn(`Refresh on Launch: ${refresh.reason}`);
      } else if (refresh.action === "rebuilt") {
        // Recreate the container so the new image is actually used; the login and
        // Workspace survive on their named volumes.
        await steps.removeBoxContainer();
      }
      await steps.ensureBoxReady(working);
    });
    // The Box is usable from here on, so this is the Sandbox User's last word on
    // it — and the only one. Bad news that did not stop the launch rides along
    // as a `notice` rather than a second status, because it changes nothing
    // about what to draw; the update reports itself to the console instead,
    // which is all a best-effort step that changes nothing on screen has to say.
    send({ ok: true, message: "Agentbox is ready.", notice: launchNotice(refresh) });
    // Behind the home screen's own first listing, never in front of it (see
    // `homeListedProjects`); capped, so a window that never asks for its
    // Projects doesn't skip the update for the whole launch. Still before any
    // session can attach — every later click queues behind this at the gate,
    // `openSession` included.
    await Promise.race([
      steps.homeListed,
      new Promise((r) => setTimeout(r, HOME_LISTING_GRACE_MS).unref()),
    ]);
    await boxGate(async () => {
      if (!(await steps.updateClaudeCode())) {
        console.warn("Claude Code update skipped; keeping the version baked into the Box image.");
      }
    });
  } catch (error) {
    // The message, not the Error: the renderer puts this straight on screen
    // under "The room stayed cold.", and `String(error)` prefixes it with a
    // second "Error:" the Sandbox User can do nothing with.
    send({ ok: false, message: `Couldn't start Agentbox: ${(error as Error).message}` });
  }
}

/**
 * The launch's bad news, for a launch that nonetheless succeeded — a rebuild
 * that failed, an integrity gate that refused, or a build that ran with no
 * reviewed commit pinned. All three used to reach `console.warn` alone, and this
 * app ships with no log file and no devtools, so "logged" meant "gone".
 *
 * `updateMessage` composes all three already, for the Update Agentbox button.
 * Its wording is written for someone who just pressed that button ("The sandbox
 * restarted on the new version") and is inherited here rather than forked — a
 * launch-specific voice is a copy pass, not a reason to leave the security gate
 * whispering to nobody (see the `unpinned` note in core/refresh.ts).
 */
function launchNotice(refresh: RefreshResult | undefined): string | undefined {
  if (!refresh) return undefined;
  const bad =
    refresh.action === "error" ||
    refresh.action === "blocked" ||
    (refresh.action === "rebuilt" && refresh.unpinned === true);
  return bad ? updateMessage(refresh) : undefined;
}
