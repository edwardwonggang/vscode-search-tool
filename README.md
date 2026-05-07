# Ripgrep Tool

> This **README** is the long description shown on the extension’s **detail page** (Extensions view / marketplace). Behaviour, limits, and setup are documented here only, not inside the search webview.

VS Code / Flow side bar search: run **ripgrep on a remote host over SSH** and browse matches in the custom view.

**Built-in `rg` (Linux) is shipped** for the remote; local Windows workspaces are mapped to Linux `/home/<user>/...` paths when possible.

## Search behaviour and limits (English)

- **No wall-clock timeout**: the remote `rg` process runs until it exits; the extension does not cut off a search by time.
- **No “max N files” cap**: the whole tree under the remote working directory is searched subject to your include/exclude globs.
- **Per-file match cap (optional)**: `ripgrepTool.maxResults` maps to ripgrep’s `--max-count` (**match lines per file**). **Default is `0`**, which **omits** `--max-count` so ripgrep applies **no** per-file cap. Set a positive value only if you need to cap very hot files.
- **UI refresh**: `ripgrepTool.resultRefreshMs` controls how often the webview updates while results stream; it does not stop the search.
- **Threads / context**: `ripgrepTool.threads` and `ripgrepTool.contextLines` are passed through to `rg` within the ranges in Settings.

**Heavy searches** can be slow or memory-heavy; limits exist so you can protect the remote or UI. For “no artificial cap” on matches per file, keep **`maxResults` at 0** (default).

## 行为与限制（中文说明）

- **无固定搜索总时长**：远程 `rg` 会跑到进程结束，扩展不会在若干秒后强行中止。
- **无“最多搜 N 个文件”这类总文件数限制**：在远端工作区目录下，会按你的包含/排除规则搜遍整棵树。
- **每文件匹配行数（可选）**：设置项 `ripgrepTool.maxResults` 对应 ripgrep 的 `--max-count`（**每个文件**最多返回的匹配行数），不是全局总条数、也不是时间限制。  
  **默认值为 `0`**：不传 `--max-count`，即**不对每文件做条数截断**；仅当你需要给特别“热”的文件加顶时，再设为大于 0 的数。
- **结果刷新间隔** `resultRefreshMs` 只影响侧栏结果列表更新频率，**不表示**会停止搜索。

若需尽量测满远程与网络能力，请保持 **`maxResults = 0`**，并根据机器情况调高 `threads` 或 `context`（注意远端 CPU、磁盘与单文件输出体积）。

## Settings (overview)

| Key | Role |
|-----|------|
| `ripgrepTool.maxResults` | `0` = no `--max-count`; `>0` = per-file line cap. |
| `ripgrepTool.contextLines` | Extra lines around each match (`--context`). |
| `ripgrepTool.threads` | `0` = auto, else `rg --threads`. |
| `ripgrepTool.resultRefreshMs` | UI batching while streaming. |
| `ripgrepTool.verboseLogging` | Extra diagnostics. Default is `false`; enable it only when troubleshooting. |

The modal “Settings” in the view configures **SSH and globs**; numeric `ripgrepTool.*` options are edited in **User/Workspace JSON settings** (or the Settings UI when the schema is listed).

## Workspace path rules

- The search view shows the current workspace path. Local drive mappings show as drive paths, UNC workspaces show as network paths, and Remote-SSH workspaces show the remote path.
- This tool is intentionally limited to a workspace opened at the Git repository root. If the current workspace folder is not the Git root, the results area shows a blocking red message and all search-view functions are disabled.
- Searches run under **Remote Search Path** when it is set. On a new computer, SSH login by itself does not know your project directory; set this to the remote project root you want to search, for example `/home/name/src/project/trunk`.
- If Remote Search Path is empty, Remote-SSH workspaces use the remote workspace path directly.
- If Remote Search Path is empty and the workspace is a UNC network path, `//server/user/rest/of/project` maps to `/home/user/rest/of/project`.
- If Remote Search Path is empty and the workspace is a local drive path, `X:\rest\of\project` maps to `/home/<SSH username>/rest/of/project`.
- Paths outside these supported forms should use Remote Search Path explicitly.
- Remote Search Path must also point at the remote Git repository root. Opening a parent directory is not supported.
- Candidate preview opens the matching file inside the current workspace URI, including Remote-SSH workspaces, instead of assuming every result is a local Windows file path.

## Development

- `npm run build` — compile
- `npm run package` — build and produce a `.vsix`
- `npm run update` — build, produce a `.vsix`, then force-install the result into every available approved editor CLI (`code`, `flow`) and common Windows install paths
