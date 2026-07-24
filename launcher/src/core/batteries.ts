/**
 * Batteries (CONTEXT.md): the tooling pre-baked into the Box so Claude can act
 * instantly with no per-session installs (ticket 03).
 *
 * This manifest is the single declaration of what the image must ship. The test
 * suite cross-checks each entry against box/Dockerfile so the two cannot drift:
 * if a runtime is dropped from the Dockerfile, the batteries test goes red.
 */
export interface Battery {
  readonly name: string;
  /** A no-install command that proves the runtime works inside the Box. */
  readonly helloWorld: string;
  /** Substrings, any of which appearing in the Dockerfile proves it's installed. */
  readonly dockerfileMarkers: readonly string[];
}

export const BATTERIES: readonly Battery[] = [
  {
    name: "node",
    helloWorld: `node -e "console.log('hello from node')"`,
    dockerfileMarkers: ["FROM node:"],
  },
  {
    name: "python",
    helloWorld: `python3 -c "print('hello from python')"`,
    dockerfileMarkers: ["python3"],
  },
  {
    name: "rust",
    helloWorld: `bash -c 'cd $(mktemp -d) && cargo init -q . && cargo run -q'`,
    dockerfileMarkers: ["rustup", "cargo"],
  },
  {
    name: "git",
    helloWorld: "git --version",
    dockerfileMarkers: ["git"],
  },
  {
    name: "mattpocock-skills",
    helloWorld: "claude plugin list",
    dockerfileMarkers: ["mattpocock-skills"],
  },
];

export function helloWorldFor(runtime: string): string | undefined {
  return BATTERIES.find((b) => b.name === runtime)?.helloWorld;
}
