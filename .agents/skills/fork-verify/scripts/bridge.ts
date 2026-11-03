// Talk to the dev app's tauri-plugin-mcp-bridge WebSocket.
// Usage:
//   node .agents/skills/fork-verify/scripts/bridge.ts js '<script>' [windowLabel]
//   node .agents/skills/fork-verify/scripts/bridge.ts shot <out.png> [windowLabel]
//   node .agents/skills/fork-verify/scripts/bridge.ts invoke <tauri command> '<json args>'
//   node .agents/skills/fork-verify/scripts/bridge.ts windows
// Port: $OI_BRIDGE_PORT, or the first bridge `pnpm dev:status` reports for this worktree.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

type Reply = { id?: string; success: boolean; data?: unknown; error?: string | null; windowContext?: unknown };

function port(): number {
  if (process.env.OI_BRIDGE_PORT) return Number(process.env.OI_BRIDGE_PORT);
  const out = execFileSync("node", ["scripts/dev-status.ts"], {
    encoding: "utf8",
    cwd: execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
  });
  const p = JSON.parse(out).bridges[0]?.port;
  if (!p) throw new Error("no bridge for this worktree; is pnpm dev:app running?");
  return p;
}

function send(command: string, args?: unknown, timeoutMs = 30000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port()}`);
    const id = `verify-${Date.now()}`;
    const timer = setTimeout(() => (ws.close(), reject(new Error(`timeout: ${command}`))), timeoutMs);
    ws.addEventListener("error", () => reject(new Error("bridge connection failed")));
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id, command, args })));
    ws.addEventListener("message", (e) => {
      const r = JSON.parse(String(e.data)) as Reply;
      if (r.id !== id) return;
      clearTimeout(timer);
      ws.close();
      resolve(r);
    });
  });
}

const [, , cmd, a, b] = process.argv;
let r: Reply;
if (cmd === "js") r = await send("execute_js", { script: a, windowLabel: b });
else if (cmd === "shot") {
  r = await send("capture_native_screenshot", { format: "png", maxWidth: 1440, windowLabel: b });
  if (r.success) {
    writeFileSync(
      a!,
      Buffer.from(
        String((r.data as { dataUrl?: string } | undefined)?.dataUrl ?? r.data).replace(/^data:[^,]+,/, ""),
        "base64",
      ),
    );
    r = { success: true, data: a, windowContext: r.windowContext };
  }
} else if (cmd === "invoke") r = await send("invoke_tauri", { command: a, args: b ? JSON.parse(b) : {} });
else if (cmd === "windows") r = await send("list_windows");
else throw new Error("usage: js|shot|invoke|windows (see header)");
console.log(JSON.stringify(r, null, 2));
if (!r.success) process.exitCode = 1;
