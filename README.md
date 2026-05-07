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
   [claude-prompt](https://github.com/gagar1n/claude-prompt) caches that JSON to
   `~/.claude/.statusline-cache.json` on every redraw.
3. This extension polls that cache file every 2 seconds and renders the
   same fields as a VS Code status-bar item.

This means the values reflect whatever **terminal** Claude Code session
is currently active. If you're not running Claude Code in a terminal,
the extension shows the most recent cached state and marks it stale
after a configurable timeout.

## Prerequisites

Install the [claude-prompt](https://github.com/gagar1n/claude-prompt) bash status line first.
That installer writes the cache file this extension reads:

```sh
git clone https://github.com/gagar1n/claude-prompt.git
cd claude-prompt && ./install.sh
```

Then run any Claude Code session in a terminal once so the cache file
gets created.

## Install

This extension is not on the VS Code Marketplace. Three install paths
depending on what you want.

### A. From a GitHub Release (recommended)

Each tagged release attaches a prebuilt `.vsix` file, produced by the
[`Release` workflow](.github/workflows/release.yml).

1. Open the [Releases page](https://github.com/gagar1n/vscode-claude-statusline/releases)
   and download the latest `claude-statusline-<version>.vsix`.
2. Install it from the command line:

   ```sh
   code --install-extension claude-statusline-<version>.vsix
   ```

   Or, in VS Code: open the **Extensions** view, click the `…` menu,
   choose **Install from VSIX…**, and pick the downloaded file.

3. Reload the window (`Ctrl/Cmd+Shift+P` → "Developer: Reload Window").

### B. Build from source

Prerequisites: a recent **Node.js** (≥ 18) and **npm**, plus the **`code`**
CLI from VS Code.

```sh
# Ubuntu / Debian
sudo apt install -y nodejs npm

# macOS (Homebrew)
brew install node

# Verify
node --version    # v18+ recommended
npm  --version
code --version
```

Then build and install:

```sh
git clone https://github.com/gagar1n/vscode-claude-statusline
cd vscode-claude-statusline
npx --yes @vscode/vsce package          # produces claude-statusline-<version>.vsix
code --install-extension claude-statusline-*.vsix
```

`npx` fetches `vsce` on demand into the npm cache; no global install is
needed. The extension itself has no runtime dependencies, so there is
no `npm install` step.

### C. Run in development mode (no install)

To iterate on the code without packaging:

1. Open the project folder in VS Code (`code .` from the repo root).
2. Press **F5**. VS Code launches an **Extension Development Host**
   window with the extension loaded.
3. Edit `src/extension.js`; reload the development-host window
   (`Ctrl/Cmd+R` inside it) to pick up changes.

This path uses VS Code's bundled Node runtime — Node does not need to
be installed system-wide for this mode.

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

## Release process

Releases are produced by the GitHub Actions workflow at
[`.github/workflows/release.yml`](.github/workflows/release.yml). It
runs on every push of a tag matching `v*` and attaches the built
`.vsix` to a GitHub Release named after the tag.

To cut a release:

```sh
# 1. Bump the version in package.json (must match the tag without the leading "v").
$EDITOR package.json

# 2. Commit and tag.
git commit -am "Release v0.2.0"
git tag v0.2.0
git push --follow-tags
```

The workflow then:

1. Verifies the tag matches `package.json`'s `version` (fails fast if not).
2. Packages the extension with `vsce`.
3. Uploads the `.vsix` as a workflow artifact (always).
4. On a tag push, creates a GitHub Release with auto-generated release
   notes and attaches the `.vsix`.

You can also trigger the workflow manually from the Actions tab via
**Run workflow**; that produces an artifact but skips the release step
because no tag is involved.

## Project layout

```
vscode-claude-statusline/
├── .github/
│   └── workflows/
│       └── release.yml     # build + GitHub Release on tag push
├── package.json            # extension manifest
├── src/
│   └── extension.js        # implementation (plain JS, no build step)
├── README.md
├── LICENSE
├── .vscodeignore
└── .gitignore
```

## License

MIT — see [LICENSE](LICENSE).
