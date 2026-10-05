# Ripgrep Tool

> This README is the long description shown on the extension detail page (Extensions view / marketplace). Search behaviour and setup are documented here only, not inside the search webview.

VS Code / Flow side bar search: run ripgrep on a remote host over SSH and browse matches in the custom view.

Built-in rg for Linux is shipped for the remote; local Windows workspaces are mapped to Linux /home/<user>/... paths when possible.

## Search Behaviour

- No wall-clock timeout: the remote rg process runs until it exits; the extension does not cut off a search by time.
- No result cap: content search, file search, and definition search are intended to return every matching item subject to exclude globs and ripgrep/ctags semantics.
- No default include whitelist: searches cover all file names that are not excluded. Use include globs only when you want to narrow the search.
- `node_modules` and obvious binary/archive/media patterns are excluded by default; source-bearing directories such as `lib`, `vendor`, `build`, `dist`, and `bin` are never excluded by default.
- Directory exclude globs ending in `/`, such as `power/`, are interpreted relative to the workspace search root. Use `**/power/**` to exclude that directory name at any depth.
- Result ranking: content and file search results are sorted by relevance instead of by path. Source files rank above test, example, mock, and compat/legacy shims, and files that contain a definition line rank first among plain sources. Among clean sources, files with more matching lines rank higher (capped) as likely topic files, and re-export/metadata barrels are penalized. Results within a file stay in line order.
- Streaming results: content search and file search update the webview while remote output is still arriving.
- UI refresh: ripgrepTool.resultRefreshMs controls how often the webview updates while results stream; it does not stop the search. The default is 80 ms so large searches show partial results quickly.
- Threads / context: ripgrepTool.threads and ripgrepTool.contextLines are passed through to rg within the ranges in Settings.
- Definition search speed: each lookup runs one combined remote probe + scan in a single SSH round trip (git root, rg/ctags presence, tags freshness, then the matching block). The scan uses `readtags` binary search on the sorted index when the remote has it (O(log N)). Without `readtags`, the build generates a small `tags.sidx` sparse offset index (one entry per 1 MiB block); the scan locates the block from the sorted index and reads only a bounded window with `dd` instead of scanning from the head of the file. Only if the sparse index is missing does it fall back to a bounded `grep -m1` + `tail` scan. A multi-hundred-MB `tags` file is therefore not fully read per query; keep the sorted index format (universal-ctags default) for these fast paths to stay correct. A lookup also validates the index freshness (git HEAD, ctags version, schema, and ctags args fingerprint) and rebuilds it when stale, so definitions are not silently missed on an old index. On high-latency SSH links each remote round trip still costs roughly 0.5-1.5 s, so a fresh connection and any ctags rebuild remain slower than warm lookups. The remote rg executable is confirmed once per connection (cached) instead of on every search; if `/tmp` is cleared and rg disappears, it is silently re-uploaded and the search is retried.

Heavy searches can be slow or memory-heavy because the extension no longer applies artificial result limits.

## Settings Overview

| Key | Role |
|-----|------|
| ripgrepTool.contextLines | Extra lines around each match (--context). |
| ripgrepTool.threads | 0 = auto, else rg --threads. |
| ripgrepTool.resultRefreshMs | UI batching while streaming. |
| ripgrepTool.verboseLogging | Extra diagnostics. Default is false; enable it only when troubleshooting. |

The modal Settings in the view configures SSH and globs; numeric ripgrepTool.* options are edited in User/Workspace JSON settings or the Settings UI when the schema is listed.

## Workspace Path Rules

- The search view shows the current workspace path. Local drive mappings show as drive paths, UNC workspaces show as network paths.
- Remote-SSH workspaces are not supported. Open the project through a local drive mapping or a UNC network path.
- Ordinary content search and file search run from the opened workspace root and cover every subdirectory, Git-managed or not. No Git repository is required.
- Definition search and ctags are limited to Git directories discovered within 3 folder levels below the workspace root. If no Git directory is found, the definition toggle and the rebuild-tags button are hidden, while content and file search remain available.
- The extension registers a VS Code DefinitionProvider for C/C++ files, so the editor's native `Go to Definition` (right-click, `Ctrl+Click`/`Cmd+Click` on macOS, or `F12`) runs the remote ctags lookup without requiring a language server plugin or a custom keybinding. A system progress notification reports the remote phases. A single match jumps directly (in the current file without opening a new tab); multiple matches use the native definition picker. The `Ripgrep: Go to Definition` command from the Command Palette still offers a floating QuickPick for multiple candidates. Definitions in other files open as a normal new tab in the same editor group (no split). No paths are excluded by default for definition search; set `ripgrepTool.definitionExcludeGlobs` only if you want to filter some results.
- Searches run under Remote Search Path when it is set. On a new computer, SSH login by itself does not know your project directory; set this to the remote project root you want to search, for example /home/name/src/project/trunk.
- Remote Search Path is auto-filled from the current workspace and saved per project. UNC and drive-letter forms that map to the same remote path share the same saved path and filter settings.
- If Remote Search Path is empty and the workspace is a UNC network path, //server/user/rest/of/project maps to /home/user/rest/of/project.
- If Remote Search Path is empty and the workspace is a local drive path, X:\rest\of\project maps to /home/<SSH username>/rest/of/project.
- Paths outside these supported forms should use Remote Search Path explicitly.
- Candidate preview opens the matching file inside the current workspace URI instead of assuming every result is a local Windows file path.
- SSH host, port, username, and password are shared globally. Remote Search Path and include/exclude globs are stored per normalized remote project.

## Development

- npm run build: compile
- npm run package: build and produce a VSIX
- npm run update: build, produce a VSIX, then force-install the result into every available approved editor CLI (code, flow) and common Windows install paths
