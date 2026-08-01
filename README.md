# Ripgrep Tool

> This README is the long description shown on the extension detail page (Extensions view / marketplace). Search behaviour and setup are documented here only, not inside the search webview.

VS Code / Flow side bar search: run ripgrep on a remote host over SSH and browse matches in the custom view.

Built-in rg for Linux is shipped for the remote; local Windows workspaces are mapped to Linux /home/<user>/... paths when possible.

## Search Behaviour

- No wall-clock timeout: the remote rg process runs until it exits; the extension does not cut off a search by time.
- No result cap: content search, file search, and definition search are intended to return every matching item subject to exclude globs and ripgrep/ctags semantics.
- No default include whitelist: searches cover all file names that are not excluded. Use include globs only when you want to narrow the search.
- Directory exclude globs ending in `/`, such as `power/`, are interpreted relative to the Git repository root. Use `**/power/**` to exclude that directory name at any depth.
- Streaming results: content search and file search update the webview while remote output is still arriving.
- UI refresh: ripgrepTool.resultRefreshMs controls how often the webview updates while results stream; it does not stop the search. The default is 80 ms so large searches show partial results quickly.
- Threads / context: ripgrepTool.threads and ripgrepTool.contextLines are passed through to rg within the ranges in Settings.

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

- The search view shows the current workspace path. Local drive mappings show as drive paths, UNC workspaces show as network paths, and Remote-SSH workspaces show the remote path.
- This tool is intentionally limited to a workspace opened at the Git repository root. If the current workspace folder is not the Git root, the results area shows a blocking red message and all search-view functions are disabled.
- Searches run under Remote Search Path when it is set. On a new computer, SSH login by itself does not know your project directory; set this to the remote project root you want to search, for example /home/name/src/project/trunk.
- If Remote Search Path is empty, Remote-SSH workspaces use the remote workspace path directly.
- If Remote Search Path is empty and the workspace is a UNC network path, //server/user/rest/of/project maps to /home/user/rest/of/project.
- If Remote Search Path is empty and the workspace is a local drive path, X:\rest\of\project maps to /home/<SSH username>/rest/of/project.
- Paths outside these supported forms should use Remote Search Path explicitly.
- Remote Search Path must also point at the remote Git repository root. Opening a parent directory is not supported.
- Candidate preview opens the matching file inside the current workspace URI, including Remote-SSH workspaces, instead of assuming every result is a local Windows file path.

## Development

- npm run build: compile
- npm run package: build and produce a VSIX
- npm run update: build, produce a VSIX, then force-install the result into every available approved editor CLI (code, flow) and common Windows install paths
