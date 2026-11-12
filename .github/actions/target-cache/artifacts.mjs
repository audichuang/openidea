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
  // Profiles in Cargo 1.100's build-dir layout: one <profile>/build/<package>/<hash>/ per unit.
  const unitLayout = new Set();
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
    for (let index = parts.length - 3; index >= 0; index--) {
      if (parts[index] !== "build" || !/^[a-f0-9]{16}$/.test(parts[index + 2])) continue;
      const profile = parts.slice(0, index).join(path.sep);
      const hashes = profiles.get(profile) ?? new Set();
      hashes.add(parts[index + 2]);
      profiles.set(profile, hashes);
      unitLayout.add(profile);
      return { profile, hash: parts[index + 2] };
    }
    // An output copied up into the profile directory (a binary, a staticlib) carries no unit hash.
    for (let index = parts.length - 1; index > 0; index--) {
      const profile = parts.slice(0, index).join(path.sep);
      if (!fs.existsSync(path.join(root, profile, ".cargo-lock"))) continue;
      if (!fs.existsSync(path.join(root, profile, "build"))) continue;
      profiles.set(profile, profiles.get(profile) ?? new Set());
      unitLayout.add(profile);
      return { profile };
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
    let matched = false;
    if (unitLayout.has(profile)) {
      const units = path.join(root, profile, "build", pkg);
      for (const hash of fs.existsSync(units) ? fs.readdirSync(units) : []) {
        if (fs.existsSync(path.join(units, hash, "fingerprint", `${prefix}-${name}.json`))) {
          profiles.get(profile).add(hash);
          matched = true;
        }
      }
    } else {
      const fingerprints = path.join(root, profile, ".fingerprint");
      for (const entry of fs.readdirSync(fingerprints)) {
        const match = entry.match(/^(.*)-([a-f0-9]{16})$/);
        if (match?.[1] === pkg && fs.existsSync(path.join(fingerprints, entry, `${prefix}-${name}.json`))) {
          profiles.get(profile).add(match[2]);
          matched = true;
        }
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
    if (unitLayout.has(profile)) {
      const build = path.join(root, profile, "build");
      for (const pkg of fs.readdirSync(build)) {
        for (const hash of fs.readdirSync(path.join(build, pkg))) {
          if (/^[a-f0-9]{16}$/.test(hash) && !hashes.has(hash)) remove(path.join(build, pkg, hash));
        }
      }
    }
    for (const directory of unitLayout.has(profile) ? [] : ["deps", ".fingerprint", "build"]) {
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
