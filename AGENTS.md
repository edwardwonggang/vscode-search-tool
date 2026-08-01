# Project Rules

Follow the global Codex rules in:

`C:\Users\10297441.WIN-9DOP5T7GHM7\.codex\AGENTS.md`

For this repo, default to `rtk` for non-interactive shell commands.

For this repo, especially prefer `rtk` when reviewing:
- `git diff`
- `rg`
- large file reads
- build/test output

Repository reading scope:
- Do not read the whole repository or broad unrelated directory trees for context.
- Read only files relevant to the current issue, implementation, or verification.
- Do not repeatedly read the same file unless it changed or a specific line range is needed for a new purpose.
- Prefer targeted `rg`, `rg --files`, narrow line ranges, and concise diffs over bulk file reads.
- For broad context, generate a bounded context pack with the global script `C:\Users\10297441.WIN-9DOP5T7GHM7\.codex\tools\context-pack\context-pack.cmd <paths...>` or this repo's wrappers `npm run context -- <paths...>` / `npm run context:changed`; do not ask Codex to inspect the whole repository directly.
- Do not read files under `.tmp-context/` unless the user explicitly asks to inspect a generated context pack.

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
- When the search view opens and the workspace is valid with complete SSH settings, automatically establish or reuse the SSH connection without requiring the user to press Connect. Keep the shared SSH client warm while the provider is alive with lightweight periodic checks; never close or interfere with connections owned by other extensions.
- When the webview restores a previous query or file query, a successful automatic SSH connection must trigger the restored search once without requiring the user to press Connect or edit the input.
- When a user-triggered search finds the bundled remote rg missing, such as after a remote Linux reboot clears `/tmp`, reupload it silently in the background. Do not add visible repair buttons, prompts, or user-facing recovery text for this path.
- Search result candidates must store and open VS Code `Uri` strings, not only local filesystem paths. Preserve Remote-SSH and non-file workspace schemes when mapping remote relative results back into the current workspace.
- The search view must display the current workspace path. File workspaces show `uri.fsPath` so mounted drive letters and UNC paths are visible; Remote-SSH workspaces show the remote path.
- Remote Search Path remains the highest-priority cwd override. If it is empty, infer remote cwd in this order: Remote-SSH workspace path as-is; UNC `//server/user/rest` to `/home/user/rest`; drive-letter `X:\rest` to `/home/<SSH username>/rest`. If none applies, require an explicit Remote Search Path.
- This tool is allowed to run only when the current workspace folder contains at least one Git repository within 3 directory levels. Discovery is recursive to depth 3, and when a Git repository is found, do not recurse deeper inside that repository. If none are found, disable all search-view controls and block all webview business actions, including search, result open, settings save, connection, and tag rebuild; render a prominent red message in the result area.
- All discovered Git repositories participate in search by default; do not add repo selection UI unless explicitly requested.
- Remote Search Path must resolve to the remote workspace root that contains the discovered Git repositories. Each resolved repository search path must also be the remote Git repository root before any content, file, definition search, or tag rebuild runs.
- Package builds should bundle extension-host dependencies into `dist/extension.js` and package with `vsce --no-dependencies` so production `node_modules`, optional native build artifacts, tests, and examples do not inflate the VSIX.
- Content search and file search must stay as separate, mutually exclusive flows. File search input clears content search input, content search input clears file search input, and backend routing must not merge file-name search into the content-match parser.
- Search flows must not impose artificial result limits. Content search, file search, and definition search should return all matching items subject only to include/exclude globs and underlying tool semantics; where remote output can stream, parse and display results incrementally instead of waiting for full command completion.
- Large search result delivery must be end-to-end incremental and bounded. Stream stdout, process lines in small time slices, push the first result batch immediately, send only newly changed matches after that, avoid final full-result UI snapshots, and keep stale/cancelled searches from rendering when users switch between large queries.
- Remote search must expose phase-level diagnostics in both the log and the search summary UI for long-running steps: SSH connect/reuse, remote path resolution, remote Git-root validation, rg/ctags readiness, SFTP upload, command spawn, first result, stream completion, cancellation, and errors. Do not leave the UI showing only an increasing timer without a backend phase.
- Default exclude globs must stay conservative and only skip obviously irrelevant locations or binary/media artifacts. Do not exclude source-bearing directory names such as `lib`, `libs`, `vendor`, `build`, `out`, `dist`, `bin`, or `obj` by default; users can add those manually when needed.
- Default include globs should be empty so content and file search cover all file names that are not excluded. Use include globs only as a user-controlled narrowing mechanism.
- Definition search ctags generation must not exclude source-bearing directories by default. Only exclude obvious binary, archive, and media file patterns unless the user explicitly configures broader excludes.
- Long-running streamed search commands must avoid collecting full stdout in memory when chunks are already processed incrementally; keep stderr available for diagnostics.
- For this repo, the local extension update path is `npm run update`: package a new versioned VSIX, then force-install the generated file through approved VS Code-family editor CLI(s). Current approved targets are VS Code (`code`) and Flow (`flow`); do not target Cursor for this company environment.
- Keep `engines.vscode` compatible with the target installed editor version; local VSIX installation is rejected before update if the target VS Code-family editor version is lower than the manifest requirement.
- Never create or keep custom inline SVG icon drawings for product UI icons. Use only dedicated open-source icon resource files checked into the repo.
- For search toolbar icons, tree expand/collapse icons, and file type icons, prefer a single coherent open-source icon set or icon theme asset pack rather than mixed ad hoc graphics.
- Treat maintainability as a primary product requirement. New extension-host functionality must be split into focused modules with clear ownership instead of adding more unrelated logic to `src/extension.ts`.
- Refactors must be behavior-preserving by default: first add or preserve automated coverage around path mapping, glob filtering, command construction, result parsing, search cancellation, and settings normalization, then move code in small verifiable steps.
- Add automated tests for reusable pure logic and regression-prone behavior before or alongside functional changes. Do not rely only on manual VSIX testing for core search behavior.
- Performance and stability changes should be measurable. Prefer bounded result batching, explicit cancellation, SSH/session reuse, streamed parsing, and clear timeout/progress diagnostics over ad hoc delays or broad rewrites.
- Every fault fix must include regression impact checks for adjacent flows before packaging: content search, file search, definition search, settings modal open/close, result click/open, cancellation/stale results, large-result rendering, and update/install packaging.
- Every search execution must be request-scoped from webview trigger through extension host state/results. Stale state, stale result chunks, and stale remote channel close events must not affect the active search.
- Input-triggered search and Enter-triggered search must share the same backend execution semantics, include/exclude behavior, collapse reset behavior, cancellation behavior, and result parsing. Trigger source may be logged or carried as metadata, but it must not change search coverage.
- Large search result rendering must use a general virtual list model that scales with both many files and many matches. Do not special-case a specific result count; render only viewport rows and keep scrolling based on stable row geometry. Prefer VS Code native list/tree UI or a mature virtualizer for major rewrites; if staying in the webview, use spacer-flow virtualization rather than absolute-positioned rows.
- Virtualized search result rows must share one row contract for file headers and match rows: fixed height, stable tree indentation columns, non-empty clickable content, and append/dedupe semantics for streamed incremental updates.
- Search result timing must distinguish backend search/parse time from webview message, merge, DOM, and paint time. Large result payloads must stay bounded, especially preview text for long single-line files, so frontend render cost cannot dominate while the backend summary looks fast.

Code simplicity and architecture:
- Follow the practical parts of Clean Code / 代码整洁之道: code should be easy to read, easy to change, and visibly written with care.
- Keep functions small and focused on one responsibility; split orchestration, validation, IO, parsing, state updates, and rendering when responsibilities mix.
- Keep a function's statements at one abstraction level. A high-level workflow should call named steps instead of mixing policy with low-level mechanics.
- Avoid hidden side effects. If a function mutates shared state, performs IO, starts async work, or changes UI, make that clear in its name, type, or owning module.
- Use intention-revealing names for modules, classes, functions, variables, and tests; avoid vague names such as manager/helper/common unless the scope is genuinely narrow and clear.
- Prefer explicit inputs and return values over output parameters, global mutation, or implicit dependencies.
- Avoid coupling unrelated features through large central classes, shared mutable state, or implicit side effects.
- Prefer composable modules with explicit inputs and outputs so feature changes stay localized.
- Add abstractions only when they isolate a volatile boundary or remove real duplication.
- Keep classes/modules small and cohesive; each should have one main reason to change.
- Design extension points around stable contracts and tests instead of adding unrelated logic to broad files or switch-heavy dispatch.
- Keep error handling separate from the main happy-path flow when doing so improves readability.
- Comments should explain intent, constraints, or non-obvious tradeoffs; do not use comments to compensate for unclear names or tangled code.
- Tests should be fast, independent, repeatable, self-validating, and focused on one behavior or concept.
- For performance-sensitive search and UI flows, avoid full snapshots, full DOM rerenders, unbounded state persistence, and unclear cancellation paths.
- Plan larger changes by affected modules, data contracts, measurable risk, and small verifiable steps before implementation.

Documentation vs UI:
- Extension behaviour, search limits, and setup notes must live in **`readme.md`**, which is what users see in the **Extensions** detail / marketplace detail page. Do not put that prose in the webview (runtime UI) unless the product explicitly needs it there.

VSIX after changes:
- Before packaging a distributable build, bump `package.json` and keep the top-level `package-lock.json` version aligned. Then run **`npm run package`** to rebuild and refresh the versioned `ripgreptool-<version>.vsix` in the repo root. A newer version should be installed over the existing extension instead of uninstalling first. Do this automatically; do not wait for the user to ask each time. After successful packaging, a short one-line note in the reply is enough; no need to pre-announce every time.
