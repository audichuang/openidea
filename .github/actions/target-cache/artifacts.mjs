import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [mode, target, manifest] = process.argv.slice(2);
if (mode === "record") {
  const output = fs.createWriteStream(target, { flags: "a" });
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    output.write(`${line}\n`);
    if (message.reason === "compiler-message" && message.message.rendered) {
      process.stderr.write(message.message.rendered);
    }
  }
  await new Promise((resolve) => output.end(resolve));
} else if (mode === "report" || mode === "prune") {
  const root = path.resolve(target);
  const profiles = new Map();
  let artifacts = 0;
  function mark(filename) {
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    const parts = relative.split(path.sep);
    const index = parts.findIndex((part) => part === "deps" || part === "build");
    if (index < 1) return;
    const profile = parts.slice(0, index).join(path.sep);
    const hashes = profiles.get(profile) ?? new Set();
    const hash = parts[index + 1]?.match(/-([a-f0-9]{16})(?:\.|$)/)?.[1];
    if (hash) hashes.add(hash);
    profiles.set(profile, hashes);
  }
  for (const line of fs.readFileSync(manifest, "utf8").trim().split("\n")) {
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact") {
      artifacts++;
      for (const filename of message.filenames) mark(filename);
    } else if (message.reason === "build-script-executed") {
      mark(message.out_dir);
    }
  }
  // Never prune from an empty or failed build's manifest.
  if (!artifacts || !profiles.size) throw new Error("No live Cargo artifacts recorded");
  function bytes(filename) {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) return 0;
    return stat.isDirectory()
      ? fs.readdirSync(filename).reduce((sum, name) => sum + bytes(path.join(filename, name)), 0)
      : stat.size;
  }
  const before = bytes(root);
  let removed = 0;
  function remove(filename) {
    removed += bytes(filename);
    if (mode === "prune") fs.rmSync(filename, { recursive: true, force: true });
  }
  for (const [profile, hashes] of profiles) {
    for (const directory of ["deps", ".fingerprint", "build"]) {
      const folder = path.join(root, profile, directory);
      if (!fs.existsSync(folder)) continue;
      for (const name of fs.readdirSync(folder)) {
        const hash = name.match(/-([a-f0-9]{16})(?:\.|$)/)?.[1];
        if (hash && !hashes.has(hash)) remove(path.join(folder, name));
      }
    }
    const incremental = path.join(root, profile, "incremental");
    if (fs.existsSync(incremental)) remove(incremental);
  }
  const mib = (value) => (value / 1024 ** 2).toFixed(1);
  console.log(
    `::notice::target artifacts (${mode}): ${mib(before)} MiB before, ${mib(removed)} MiB obsolete, ${mib(before - removed)} MiB retained; ${artifacts} live artifacts`,
  );
} else {
  throw new Error("Expected record, report or prune");
}
