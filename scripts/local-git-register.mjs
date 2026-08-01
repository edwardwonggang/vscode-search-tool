import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultStore = 'D:\\local-git-repos';
const projectDirectory = path.resolve(process.argv[2] || process.cwd());
const requestedName = process.argv[3] || path.basename(projectDirectory);
const storeDirectory = path.resolve(process.env.RIPGREPTOOL_LOCAL_GIT_STORE || defaultStore);

function runGit(args, cwd = projectDirectory) {
  return execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 4 });
}

function safeProjectName(value) {
  const name = String(value).trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!name) throw new Error('Project name is empty.');
  return name;
}

async function ensureBareRepository(repositoryDirectory) {
  try {
    const result = await runGit(['--git-dir', repositoryDirectory, 'rev-parse', '--is-bare-repository'], storeDirectory);
    if (result.stdout.trim() !== 'true') throw new Error(`Target is not a bare repository: ${repositoryDirectory}`);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !String(error?.message || '').includes('not a git repository')) throw error;
    await runGit(['init', '--bare', repositoryDirectory], storeDirectory);
  }
}

async function getBranchName() {
  const result = await runGit(['symbolic-ref', '--short', 'HEAD']);
  const branch = result.stdout.trim();
  if (!branch) throw new Error('The project is in detached HEAD state.');
  return branch;
}

async function configureLocalRemote(repositoryDirectory) {
  try {
    const result = await runGit(['remote', 'get-url', 'local']);
    if (path.resolve(result.stdout.trim()) !== path.resolve(repositoryDirectory)) {
      throw new Error(`Remote 'local' already points to another repository: ${result.stdout.trim()}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('already points')) throw error;
    await runGit(['remote', 'add', 'local', repositoryDirectory]);
  }
}

async function main() {
  await stat(projectDirectory);
  await mkdir(storeDirectory, { recursive: true });
  const projectName = safeProjectName(requestedName);
  const repositoryDirectory = path.join(storeDirectory, `${projectName}.git`);
  const branch = await getBranchName();
  await ensureBareRepository(repositoryDirectory);
  await configureLocalRemote(repositoryDirectory);
  await runGit(['push', 'local', branch]);
  console.log(`Registered project: ${projectName}`);
  console.log(`Local repository: ${repositoryDirectory}`);
  console.log(`Branch pushed: ${branch}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
