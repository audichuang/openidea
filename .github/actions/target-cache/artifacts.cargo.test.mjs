import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./artifacts.mjs", import.meta.url));

for (const nativeDir of ["native", "cache-native"]) {
  test(`prune preserves Cargo freshness with package directory ${nativeDir}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "target-cache-cargo-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = {
      "Cargo.toml": `[workspace]\nmembers = ["${nativeDir}", "consumer"]\nresolver = "2"\n`,
      [`${nativeDir}/Cargo.toml`]: `[package]
name = "cache-native"
version = "0.0.0"
edition = "2024"

[lib]
name = "bridge_lib"
crate-type = ["rlib", "staticlib", "cdylib"]

[[bin]]
name = "fixture-tool"
path = "src/main.rs"
`,
      [`${nativeDir}/src/lib.rs`]: "pub fn answer() -> u32 { 42 }\n",
      [`${nativeDir}/src/main.rs`]: 'fn main() { println!("{}", bridge_lib::answer()); }\n',
      [`${nativeDir}/build.rs`]: 'fn main() { println!("cargo:rerun-if-changed=build.rs"); }\n',
      [`${nativeDir}/tests/cli.rs`]: `#[test]
fn runs_binary() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_fixture-tool")).output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"42\\n");
}
`,
      "consumer/Cargo.toml": `[package]
name = "cache-consumer"
version = "0.0.0"
edition = "2024"

[dependencies]
bridge_lib = { package = "cache-native", path = "../${nativeDir}" }
`,
      "consumer/src/lib.rs": "pub fn answer() -> u32 { bridge_lib::answer() }\n",
    };
    for (const [name, source] of Object.entries(files)) {
      const filename = path.join(root, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, source);
    }
    const target = path.join(root, "target");
    const env = {
      ...process.env,
      CARGO_HOME: path.join(root, ".cargo"),
      CARGO_TARGET_DIR: target,
      CARGO_INCREMENTAL: "0",
      CARGO_PROFILE_DEV_DEBUG: "0",
      RUSTC_WRAPPER: "",
      RUSTC_WORKSPACE_WRAPPER: "",
      CARGO_BUILD_RUSTC_WRAPPER: "",
      CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "",
    };
    function build() {
      const result = spawnSync(
        process.env.CARGO || "cargo",
        ["test", "--workspace", "--no-run", "--offline", "--message-format=json"],
        { cwd: root, env, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    }
    function assertFresh(messages, phase) {
      const artifacts = messages.filter((message) => message.reason === "compiler-artifact");
      assert.ok(artifacts.length > 0);
      const rebuilt = artifacts
        .filter((artifact) => !artifact.fresh)
        .map((artifact) => ({
          name: artifact.target.name,
          kind: artifact.target.kind,
          test: artifact.profile.test,
        }));
      t.diagnostic(`${phase}: ${artifacts.length - rebuilt.length}/${artifacts.length} artifacts fresh`);
      assert.deepEqual(rebuilt, [], `${phase}: rebuilt ${JSON.stringify(rebuilt)}`);
    }
    build();
    const before = build();
    assertFresh(before, "before prune");
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false, "fixture must use its own Cargo target");
    const manifest = path.join(root, "live.jsonl");
    fs.writeFileSync(manifest, before.map((message) => JSON.stringify(message)).join("\n"));
    const prune = spawnSync(process.execPath, [script, "prune", target, manifest], { encoding: "utf8" });
    assert.equal(prune.status, 0, prune.stderr);
    assertFresh(build(), "after prune");
  });
}
