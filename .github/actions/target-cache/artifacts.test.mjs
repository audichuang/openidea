import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./artifacts.mjs", import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "target-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const files = [
    "debug/deps/liblive-1111111111111111.rlib",
    "debug/deps/liblive-1111111111111111.rmeta",
    "debug/deps/live-1111111111111111.d",
    "debug/.fingerprint/live-1111111111111111/lib-live.json",
    "debug/deps/liblive-2222222222222222.rmeta",
    "debug/.fingerprint/live-2222222222222222/lib-live.json",
    "debug/build/live-3333333333333333/out/generated.rs",
    "debug/.fingerprint/live-3333333333333333/run-build-script.json",
    "debug/deps/libold-4444444444444444.rlib",
    "debug/.fingerprint/old-4444444444444444/lib-old.json",
    "debug/build/old-4444444444444444/out/generated.rs",
    "debug/incremental/old/work.o",
  ];
  for (const name of files) {
    const file = path.join(target, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "artifact");
  }
  const manifest = path.join(root, "artifacts.jsonl");
  const messages = [
    { reason: "compiler-artifact", filenames: [path.join(target, files[0])] },
    { reason: "compiler-artifact", filenames: [path.join(target, files[4])] },
    { reason: "build-script-executed", out_dir: path.join(target, "debug/build/live-3333333333333333/out") },
  ];
  fs.writeFileSync(manifest, messages.map((message) => JSON.stringify(message)).join("\n"));
  const run = (mode) => spawnSync(process.execPath, [script, mode, target, manifest], { encoding: "utf8" });
  return { target, files, manifest, run };
}

test("prune keeps live test, clippy, dep-info and build-script artifacts", (t) => {
  const { target, files, run } = fixture(t);
  const result = run("prune");
  assert.equal(result.status, 0, result.stderr);
  for (const [index, name] of files.entries()) {
    assert.equal(fs.existsSync(path.join(target, name)), index < 8, name);
  }
});

test("report measures without deleting artifacts", (t) => {
  const { target, files, run } = fixture(t);
  const result = run("report");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /obsolete/);
  for (const name of files) assert.ok(fs.existsSync(path.join(target, name)), name);
});

test("empty manifest fails before deleting anything", (t) => {
  const { target, files, manifest, run } = fixture(t);
  fs.writeFileSync(manifest, JSON.stringify({ reason: "build-finished", success: false }));
  assert.notEqual(run("prune").status, 0);
  for (const name of files) assert.ok(fs.existsSync(path.join(target, name)), name);
});
