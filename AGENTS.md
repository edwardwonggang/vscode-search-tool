# Project Rules

Follow the global Codex rules in:

`C:\Users\10297441.WIN-9DOP5T7GHM7\.codex\AGENTS.md`

For this repo, default to `rtk` for non-interactive shell commands.

For this repo, especially prefer `rtk` when reviewing:
- `git diff`
- `rg`
- large file reads
- build/test output

Keep raw shell commands for:
- short status checks
- exact output validation
- interactive or timing-sensitive commands

Mandatory `rtk` recovery rule:
- If any `rtk` command fails, do not fall back to the equivalent raw shell command.
- First diagnose and fix the `rtk` issue.
- Only continue the task after `rtk` is working again.

Mandatory implementation rules for this repo:
- All source and resource files must be UTF-8.
- Do not continue editing a file after any encoding corruption or garbled text is detected. Rebuild the affected content from clean UTF-8 text first.
- Do not place Chinese UI text directly in code files. UI-facing text must live in dedicated translation resources.
- Webview UI must be split into dedicated files. Do not keep large HTML/CSS/JS templates inline inside TypeScript unless there is a compelling technical reason.
- Search view UI text must be loaded from a translation CSV mapping rather than hardcoded string literals in code.
- When adding UI strings, update the translation resource first, then reference stable keys from code.
- Keep architecture modular: extension host logic, webview markup, webview behavior, styles, and translations should have separate files with clear ownership.
- Search webview initial render must not depend on SSH, remote tools, network access, or restored search state. Do not start remote search automatically from persisted webview state on load.
- SSH work must happen only after an explicit user action such as Search, Connect, or Rebuild Tags; connection progress should be reported separately from remote tool setup.
- Remote SSH sessions should be reused across content search, file search, definition search, connection, and tag rebuild when SSH settings are unchanged. Starting a new search should cancel only the active remote command/channel, not close the shared SSH client; close the client only on SSH setting changes, remote close/error, provider disposal, or explicit teardown.
- Search result candidates must store and open VS Code `Uri` strings, not only local filesystem paths. Preserve Remote-SSH and non-file workspace schemes when mapping remote relative results back into the current workspace.
- The search view must display the current workspace path. File workspaces show `uri.fsPath` so mounted drive letters and UNC paths are visible; Remote-SSH workspaces show the remote path.
- Remote Search Path remains the highest-priority cwd override. If it is empty, infer remote cwd in this order: Remote-SSH workspace path as-is; UNC `//server/user/rest` to `/home/user/rest`; drive-letter `X:\rest` to `/home/<SSH username>/rest`. If none applies, require an explicit Remote Search Path.
- This tool is allowed to run only when the current workspace folder is the Git repository root. If not, disable all search-view controls and block all webview business actions, including search, result open, settings save, connection, and tag rebuild; render a prominent red message in the result area.
- Remote Search Path must also resolve to the remote Git repository root before any content, file, or definition search runs.
- Package builds should bundle extension-host dependencies into `dist/extension.js` and package with `vsce --no-dependencies` so production `node_modules`, optional native build artifacts, tests, and examples do not inflate the VSIX.
- Content search and file search must stay as separate, mutually exclusive flows. File search input clears content search input, content search input clears file search input, and backend routing must not merge file-name search into the content-match parser.
- For this repo, the local extension update path is `npm run update`: package a new versioned VSIX, then force-install the generated file through approved VS Code-family editor CLI(s). Current approved targets are VS Code (`code`) and Flow (`flow`); do not target Cursor for this company environment.
- Keep `engines.vscode` compatible with the target installed editor version; local VSIX installation is rejected before update if the target VS Code-family editor version is lower than the manifest requirement.
- Never create or keep custom inline SVG icon drawings for product UI icons. Use only dedicated open-source icon resource files checked into the repo.
- For search toolbar icons, tree expand/collapse icons, and file type icons, prefer a single coherent open-source icon set or icon theme asset pack rather than mixed ad hoc graphics.

Documentation vs UI:
- Extension behaviour, search limits, and setup notes must live in **`readme.md`**, which is what users see in the **Extensions** detail / marketplace detail page. Do not put that prose in the webview (runtime UI) unless the product explicitly needs it there.

VSIX after changes:
- Before packaging a distributable build, bump `package.json` and keep the top-level `package-lock.json` version aligned. Then run **`npm run package`** to rebuild and refresh the versioned `ripgreptool-<version>.vsix` in the repo root. A newer version should be installed over the existing extension instead of uninstalling first. Do this automatically; do not wait for the user to ask each time. After successful packaging, a short one-line note in the reply is enough; no need to pre-announce every time.
