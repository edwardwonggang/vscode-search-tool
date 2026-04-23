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

Mandatory implementation rules for this repo:
- All source and resource files must be UTF-8.
- Do not continue editing a file after any encoding corruption or garbled text is detected. Rebuild the affected content from clean UTF-8 text first.
- Do not place Chinese UI text directly in code files. UI-facing text must live in dedicated translation resources.
- Webview UI must be split into dedicated files. Do not keep large HTML/CSS/JS templates inline inside TypeScript unless there is a compelling technical reason.
- Search view UI text must be loaded from a translation CSV mapping rather than hardcoded string literals in code.
- When adding UI strings, update the translation resource first, then reference stable keys from code.
- Keep architecture modular: extension host logic, webview markup, webview behavior, styles, and translations should have separate files with clear ownership.
- Never create or keep custom inline SVG icon drawings for product UI icons. Use only dedicated open-source icon resource files checked into the repo.
- For search toolbar icons, tree expand/collapse icons, and file type icons, prefer a single coherent open-source icon set or icon theme asset pack rather than mixed ad hoc graphics.

Documentation vs UI:
- Extension behaviour, search limits, and setup notes must live in **`readme.md`**, which is what users see in the **Extensions** detail / marketplace detail page. Do not put that prose in the webview (runtime UI) unless the product explicitly needs it there.

VSIX after changes:
- At the end of any task that changes this extension (TypeScript, `media/`, `package.json`, etc.), run **`npm run package`** to rebuild and refresh `ripgreptool-0.0.1.vsix` in the repo root. Do this automatically; do not wait for the user to ask each time. After successful packaging, a short one-line note in the reply is enough; no need to pre-announce every time.
