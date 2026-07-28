interface Window {
  agentbox: import("../shared/api").AgentboxApi;
}

// Global type aliases (inline import() keeps this a global .d.ts, no top-level
// import) so no renderer script needs an `import` — which lets tsc emit each of
// them as a plain classic script instead of a CommonJS module the browser can't
// run.
type Project = import("../core/projects").Project;
type ExportCandidate = import("../core/export").ExportCandidate;
type ExportListing = import("../core/export").ExportListing;
type ExportResult = import("../core/export").ExportResult;
type ImportListing = import("../core/import").ImportListing;
type GithubStatus = import("../shared/api").GithubStatus;
type DeleteListing = import("../core/delete").DeleteListing;
type FileDeleteResult = import("../core/delete").FileDeleteResult;
