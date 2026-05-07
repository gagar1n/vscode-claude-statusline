# vscode-claude-statusline

A small VS Code extension that shows live Claude Code session info in the
status bar — the same data the terminal `statusLine` script displays:

- **Model** in use
- **Thinking effort** level
- **5-hour rate limit** — % used
- **7-day rate limit** — % used
- **Context window** usage — %

```
$(zap) Opus 4.7 · effort:high · 5h:23% · 7d:41% · ctx:12%
```

Hover the status bar item for a full breakdown including reset ETAs and
the source cache path.

The status bar background turns **yellow** when any percentage hits 50%,
**red** at 80%. Stale data (cache file older than the threshold) renders
prefixed with `(stale)` and the background colour is dropped.

## How it works

VS Code's Claude extension does not surface live session metrics. This
extension piggybacks on the terminal CLI's status-line script:

1. The Claude Code CLI calls a configured shell script for every status
   redraw, passing a JSON blob via stdin (model, effort, rate limits,
   context, etc.).
2. The companion script in
   [claude-prompt](../claude-prompt) caches that JSON to
   `~/.claude/.statusline-cache.json` on every redraw.
3. This extension polls that cache file every 2 seconds and renders the
   same fields as a VS Code status-bar item.

This means the values reflect whatever **terminal** Claude Code session
is currently active. If you're not running Claude Code in a terminal,
the extension shows the most recent cached state and marks it stale
after a configurable timeout.

## Prerequisites

Install the [claude-prompt](../claude-prompt) bash status line first.
That installer writes the cache file this extension reads:

```sh
~/r/gagar1n/claude-prompt/install.sh
```

Then run any Claude Code session in a terminal once so the cache file
gets created.

## Install (development / sideload)

This extension is not published to the VS Code Marketplace. Install
locally:

```sh
cd ~/r/gagar1n/vscode-claude-statusline
npm install -g @vscode/vsce          # one-time, if you don't have it
vsce package                         # produces claude-statusline-0.1.0.vsix
code --install-extension claude-statusline-0.1.0.vsix
```

To iterate on the code without packaging, open the folder in VS Code
and press `F5` — it launches an Extension Development Host with the
extension loaded.

## Settings

| Setting                              | Default                              | Description                                                                 |
| ------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------- |
| `claudeStatusline.cachePath`         | `~/.claude/.statusline-cache.json`   | Path to the JSON cache file. Empty string falls back to the default.        |
| `claudeStatusline.refreshIntervalMs` | `2000`                               | How often (ms) to re-read the cache file.                                   |
| `claudeStatusline.staleThresholdSec` | `300`                                | Mark data as stale when the cache file mtime exceeds this many seconds.    |
| `claudeStatusline.alignment`         | `right`                              | `left` or `right` side of the status bar.                                  |
| `claudeStatusline.priority`          | `100`                                | Status bar priority (higher = closer to centre).                            |

## Commands

- **Claude Status Line: Refresh** — re-read the cache file immediately.
  Bound to clicking the status-bar item.
- **Claude Status Line: Open Cache File** — open the JSON cache file in
  an editor (handy for debugging).

## Known limitations

- **Reflects the terminal session, not the VS Code chat.** Claude Code's
  VS Code panel does not expose its own status to extensions, so we
  can only mirror whatever the terminal CLI most recently produced.
- **Polling, not push.** Updates lag by up to `refreshIntervalMs`. The
  extension diffs the rendered text and skips redraws when nothing has
  changed, so the cost is just one `stat` + (occasional) read per tick.
- **Free-tier accounts** don't get rate-limit data from the API; the
  `5h` / `7d` segments simply won't appear.

## Project layout

```
vscode-claude-statusline/
├── package.json        # extension manifest
├── src/
│   └── extension.js    # implementation (plain JS, no build step)
├── README.md
├── LICENSE
├── .vscodeignore
└── .gitignore
```

## License

MIT — see [LICENSE](LICENSE).
