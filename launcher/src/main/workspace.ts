/**
 * Box-side Workspace operations. Because the Workspace is a NAMED VOLUME and not
 * a host mount (ADR 0001, threat A), the Launcher cannot write Project folders
 * on the host — it brokers them into the Box through the Box-exec seam
 * (`./box-exec`), which owns every `docker exec` / `docker cp` here: its argv,
 * its shell quoting, and the rule that a non-zero exit is an error.
 *
 * The DECISIONS (safe slug, collision-free destinations) come from the pure,
 * tested core helpers; only the EFFECTS live here.
 *
 * Every entry point takes the Box as its last argument, defaulted to the real
 * one, so these operations are assertable against a fake Box — the same
 * injection style as `spawnPath(path, exists)` and `markExportedUntrusted`.
 * `run` survives only for HOST commands (`git`, `xattr`), never for the Box.
 */

/**
 * This file is that layer's front door and nothing else: `main/ipc.ts` imports
 * from here, and `test/box-gate.test.ts` mocks exactly this module, so the five
 * concerns below keep one import surface between them. Named rather than `export
 * *`, so what the rest of the Launcher may reach is a list someone wrote.
 */
export { boxCreateProject, boxListProjects } from "./workspace-projects";
export {
  boxExport,
  boxExportDir,
  boxExportListing,
  lastSavedAt,
  markExportedUntrusted,
  withLastSaved,
} from "./workspace-export";
export { boxDeleteFiles, boxDeleteListing, boxDeleteProject } from "./workspace-delete";
export { boxUpload } from "./workspace-upload";
export { boxImportFolder, boxPlanImport } from "./workspace-import";
