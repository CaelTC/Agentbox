"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnPath = spawnPath;
exports.run = run;
exports.runOk = runOk;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
/**
 * A GUI app launched from Finder/Dock inherits a minimal PATH (no login shell),
 * so Homebrew's bin dirs are missing — Apple-Silicon `/opt/homebrew/bin` holds
 * `colima`, hence "spawn colima ENOENT". Prepend the standard Homebrew locations
 * that actually exist so every spawn can find colima/docker. Colleagues without
 * Homebrew get an unchanged PATH (no phantom dirs added).
 * ponytail: covers Homebrew installs; if colima lives elsewhere, add its dir here.
 */
function spawnPath(path = process.env.PATH ?? "", exists = node_fs_1.existsSync) {
    const brew = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
    const add = brew.filter((d) => exists(d) && !path.split(":").includes(d));
    return [...add, path].filter(Boolean).join(":");
}
function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PATH: spawnPath() },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}
/** Run a command and resolve to true only on a clean (exit 0) run. */
async function runOk(command, args) {
    try {
        return (await run(command, args)).code === 0;
    }
    catch {
        return false;
    }
}
