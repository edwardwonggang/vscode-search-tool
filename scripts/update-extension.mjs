import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const vsixPath = resolve(root, `${manifest.name}-${manifest.version}.vsix`);
const editorCommands = process.argv.slice(2);
const defaultEditorCommands = ['code', 'flow'];
const commonWindowsEditorPaths = [
  'D:\\Programs\\Microsoft VS Code\\bin\\code.cmd',
  'D:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Microsoft VS Code\\bin\\code.cmd`,
  'D:\\Programs\\Flow\\bin\\flow.cmd',
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Flow\\bin\\flow.cmd`
].filter((candidate) => candidate && !candidate.startsWith('\\'));
const targets = editorCommands.length > 0 ? editorCommands : discoverDefaultTargets();

run('npm', ['run', 'package']);

if (!existsSync(vsixPath)) {
  throw new Error(`Packaged VSIX not found: ${vsixPath}`);
}

let installed = 0;
const failures = [];
for (const command of targets) {
  if (!isTargetAvailable(command)) {
    console.log(`[skip] ${command} was not found on PATH`);
    continue;
  }

  console.log(`[install] ${command} --install-extension ${vsixPath} --force`);
  try {
    run(command, ['--install-extension', vsixPath, '--force']);
    installed += 1;
  } catch (error) {
    failures.push(`${command}: ${error.message}`);
    console.log(`[failed] ${command}: ${error.message}`);
  }
}

if (installed === 0) {
  throw new Error(`No editor CLI installed the extension. Tried: ${targets.join(', ')}. ${failures.join(' | ')}`);
}

console.log(`[done] Installed ${manifest.publisher}.${manifest.name}@${manifest.version} from ${vsixPath}`);
if (failures.length > 0) {
  console.log(`[warn] Some editor installs failed: ${failures.join(' | ')}`);
}

function isCommandAvailable(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
      cwd: root,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

function isTargetAvailable(command) {
  return isPathLike(command) ? existsSync(command) : isCommandAvailable(command);
}

function discoverDefaultTargets() {
  const found = [];
  for (const command of defaultEditorCommands) {
    if (isCommandAvailable(command)) {
      found.push(command);
    }
  }

  const seen = new Set(found.map(normalizeTargetKey));
  for (const command of commonWindowsEditorPaths) {
    if (existsSync(command) && !seen.has(normalizeTargetKey(command))) {
      found.push(command);
      seen.add(normalizeTargetKey(command));
    }
  }
  return found.length > 0 ? found : defaultEditorCommands;
}

function isPathLike(command) {
  return /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
}

function normalizeTargetKey(command) {
  const lower = command.toLowerCase();
  if (!isPathLike(command)) {
    return lower;
  }
  return `${basename(command).toLowerCase()}@${dirname(command).toLowerCase()}`;
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
}
