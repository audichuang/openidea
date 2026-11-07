// Run JS in an app window through the MCP bridge's WebSocket, for sessions without mcp__tauri__* tools.
// Usage: node bridge-js.mjs <port> <windowLabel> '<script>'     (port from `pnpm dev:status`)
//        node bridge-js.mjs <port> - '<json args>' <command>    (any other bridge command)
// The script may `return` a value or a promise. Needs Node 22+ (built-in WebSocket).
const [port, label, script, command] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const timer = setTimeout(() => {
  console.error("timeout");
  process.exit(2);
}, 15000);
ws.onopen = () =>
  ws.send(
    JSON.stringify(
      command
        ? { id: "1", command, args: JSON.parse(script || "{}") }
        : { id: "1", command: "execute_js", args: { script, windowLabel: label } },
    ),
  );
ws.onmessage = (event) => {
  const reply = JSON.parse(String(event.data));
  if (reply.id !== "1") return;
  clearTimeout(timer);
  // process.exit right after console.log truncates a large reply on a piped stdout; exit once it is flushed.
  if (!reply.success) {
    process.stdout.write(`ERROR ${reply.error}\n`, () => process.exit(1));
    return;
  }
  const text = typeof reply.data === "string" ? reply.data : JSON.stringify(reply.data);
  process.stdout.write(`${text}\n`, () => process.exit(0));
};
ws.onerror = (event) => {
  console.error("websocket error", event.message ?? "");
  process.exit(3);
};
