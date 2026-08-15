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
  /** Substrings, any of which appearing in the Dockerfile proves it's installed. */
  readonly dockerfileMarkers: readonly string[];
}

export const BATTERIES: readonly Battery[] = [
  { name: "node", dockerfileMarkers: ["FROM node:"] },
  { name: "python", dockerfileMarkers: ["python3"] },
  { name: "rust", dockerfileMarkers: ["rustup", "cargo"] },
  { name: "git", dockerfileMarkers: ["git"] },
  // The scoped package name, not "codex": the bare word could match a comment.
  { name: "codex", dockerfileMarkers: ["@openai/codex"] },
  {
    name: "mattpocock-skills",
    // The full plugin id, not just the plugin name: a Dockerfile that merely
    // mentions "mattpocock-skills" once installed `mattpocock-skills@mattpocock-skills`
    // from a repo that does not exist, and this test still passed.
    dockerfileMarkers: ["mattpocock-skills@mattpocock"],
  },
  // The same skills, ported for Codex (box/codex-skills/README.md). The image
  // path, not the source directory: `box/codex-skills` appears in the build
  // context whether or not the Dockerfile ever copies it in.
  { name: "codex-skills", dockerfileMarkers: ["/opt/codex-skills/"] },
];
