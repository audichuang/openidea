# Theme switching

## Sub-features

Light, dark, dark high contrast, and color themes (solarized, one-light/dark, imported .icls). Tokens in `src/styles/tokens.css`; selectors `:root[data-theme=...]`, `:root[data-color-theme=...]`.

## How to get to it (user POV)

Settings → Appearance → Theme; also Quick Switch Scheme.

## Driving it with Tauri MCP

- Set: `webview_execute_js` with `import("/src/bindings.ts").then(m => m.commands.settingsSet("global", "appearance.theme", JSON.stringify("dark"))).then(r => r.status)`.
- Read: `webview_execute_js` with `document.documentElement.dataset.theme`.

Proof: `data-theme` changes in every open window, and `getComputedStyle` of the element under test resolves to the token for that theme. Screenshot each theme the change affects.

## Gotchas

- Read the current value first and restore it at the end.
- Colors resolve as `oklab(...)`/`color(srgb ...)` when tokens use `color-mix`; convert before comparing with hex.
