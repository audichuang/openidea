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
  const unhashed = [];
  let artifacts = 0;
  function mark(filename) {
    const relative = path.relative(root, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    const parts = relative.split(path.sep);
    for (let index = parts.length - 1; index > 0; index--) {
      const profile = parts.slice(0, index).join(path.sep);
      if (!fs.existsSync(path.join(root, profile, ".fingerprint"))) continue;
      const hashes = profiles.get(profile) ?? new Set();
      const hash = parts[index + 1]?.match(/-([a-f0-9]{16})(?:\.|$)/)?.[1];
      if (hash) hashes.add(hash);
      profiles.set(profile, hashes);
      return { profile, hash };
    }
  }
  for (const line of fs.readFileSync(manifest, "utf8").trim().split("\n")) {
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact") {
      artifacts++;
      const units = message.filenames.map(mark).filter(Boolean);
      if (!units.some((unit) => unit.hash)) {
        for (const profile of new Set(units.map((unit) => unit.profile))) {
          unhashed.push({ profile, message });
        }
      }
    } else if (message.reason === "build-script-executed") {
      mark(message.out_dir);
    }
  }
  // Never prune from an empty or failed build's manifest.
  if (!artifacts || !profiles.size) throw new Error("No live Cargo artifacts recorded");
  for (const { profile, message } of unhashed) {
    const id = new URL(message.package_id);
    const spec = decodeURIComponent(id.hash.slice(1));
    const pkg = spec.includes("@")
      ? spec.slice(0, spec.lastIndexOf("@"))
      : path.posix.basename(decodeURIComponent(id.pathname));
    const { kind, name } = message.target;
    const testPrefix = message.profile.test ? "test-" : "";
    let prefix;
    if (kind.includes("bin")) prefix = `${testPrefix}bin`;
    else if (kind.includes("example")) prefix = `${testPrefix}example`;
    else if (kind.includes("test")) prefix = "test-integration-test";
    else if (kind.includes("bench")) prefix = "test-bench";
    else if (kind.includes("custom-build")) prefix = "build-script";
    else if (kind.some((value) => ["lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"].includes(value))) {
      prefix = `${testPrefix}lib`;
    } else {
      throw new Error(`Unknown Cargo target kind: ${kind}`);
    }
    // Unhashed outputs cannot select a unit: keep matching package/target fingerprints and outputs.
    const fingerprints = path.join(root, profile, ".fingerprint");
    let matched = false;
    for (const entry of fs.readdirSync(fingerprints)) {
      const match = entry.match(/^(.*)-([a-f0-9]{16})$/);
      if (match?.[1] === pkg && fs.existsSync(path.join(fingerprints, entry, `${prefix}-${name}.json`))) {
        profiles.get(profile).add(match[2]);
        matched = true;
      }
    }
    if (!matched) throw new Error(`No fingerprint for live Cargo target ${pkg}/${prefix}-${name}`);
  }
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
