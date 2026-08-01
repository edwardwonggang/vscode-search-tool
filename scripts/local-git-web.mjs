import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultStore = 'D:\\local-git-repos';
const storeDirectory = path.resolve(process.argv[2] || process.env.RIPGREPTOOL_LOCAL_GIT_DIR || defaultStore);
const port = parsePort(process.argv[3] || process.env.RIPGREPTOOL_GIT_WEB_PORT);
const webFiles = new Map([
  ['/', 'local-git-web.html'],
  ['/app.js', 'local-git-web.js'],
  ['/styles.css', 'local-git-web.css']
]);

function parsePort(value) {
  const parsed = Number.parseInt(String(value || '4177'), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 4177;
}

function parsePositiveInt(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function runGit(repositoryDirectory, args, maxBuffer = 1024 * 1024 * 8) {
  return execFileAsync('git', ['--git-dir', repositoryDirectory, ...args], {
    cwd: scriptDirectory,
    maxBuffer,
    windowsHide: true
  });
}

function resolveProject(projectName) {
  if (!projectName || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.git$/u.test(projectName)) {
    throw new Error('A valid project must be selected.');
  }
  const repositoryDirectory = path.resolve(storeDirectory, projectName);
  if (path.dirname(repositoryDirectory) !== storeDirectory) {
    throw new Error('Invalid project path.');
  }
  return repositoryDirectory;
}

async function listProjects() {
  await mkdir(storeDirectory, { recursive: true });
  const entries = await readdir(storeDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.git'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return await Promise.all(names.map(async (name) => {
    const repositoryDirectory = resolveProject(name);
    const summary = await getRepositorySummary(repositoryDirectory);
    return { id: name, name: name.slice(0, -4), ...summary };
  }));
}

async function getRepositorySummary(repositoryDirectory) {
  const [isBare, head, branch, refs] = await Promise.all([
    runGit(repositoryDirectory, ['rev-parse', '--is-bare-repository'])
      .then(({ stdout }) => stdout.trim() === 'true'),
    runGit(repositoryDirectory, ['rev-parse', 'HEAD']).then(({ stdout }) => stdout.trim()).catch(() => ''),
    runGit(repositoryDirectory, ['symbolic-ref', '--short', 'HEAD'])
      .then(({ stdout }) => stdout.trim()).catch(() => 'detached'),
    runGit(repositoryDirectory, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      .then(({ stdout }) => stdout.trim().split(/\r?\n/u).filter(Boolean))
      .catch(() => [])
  ]);
  if (!isBare) throw new Error(`Not a bare repository: ${repositoryDirectory}`);
  return { repository: repositoryDirectory, head, branch, refs };
}

function parseCommitRecords(output) {
  return output.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [hash, shortHash, author, email, date, subject] = record.split('\x1f');
    return { hash, shortHash, author, email, date, subject };
  });
}

async function getCommits(url) {
  const repositoryDirectory = resolveProject(url.searchParams.get('project'));
  const skip = parsePositiveInt(url.searchParams.get('skip'), 0, 1000000);
  const requestedLimit = parsePositiveInt(url.searchParams.get('limit'), 50, 200);
  const output = await runGit(repositoryDirectory, [
    'log',
    '--all',
    '--date=iso-strict',
    `--skip=${skip}`,
    `--max-count=${requestedLimit + 1}`,
    '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e'
  ]);
  const records = parseCommitRecords(output.stdout);
  return {
    skip,
    limit: requestedLimit,
    hasMore: records.length > requestedLimit,
    commits: records.slice(0, requestedLimit)
  };
}

function validateCommitHash(value) {
  if (!/^[0-9a-f]{7,64}$/iu.test(value)) throw new Error('Invalid commit id.');
  return value;
}

async function getCommitDetails(url, hash) {
  const repositoryDirectory = resolveProject(url.searchParams.get('project'));
  const commit = validateCommitHash(hash);
  const [header, files, diff] = await Promise.all([
    runGit(repositoryDirectory, ['show', '-s', '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s', commit]),
    runGit(repositoryDirectory, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '--find-renames', commit]),
    runGit(repositoryDirectory, ['show', '--format=', '--find-renames', '--find-copies', commit], 1024 * 1024 * 16)
  ]);
  const [fullHash, shortHash, author, email, date, subject] = header.stdout.trim().split('\x1f');
  return {
    commit: { hash: fullHash, shortHash, author, email, date, subject },
    files: files.stdout.trim().split(/\r?\n/u).filter(Boolean),
    diff: diff.stdout
  };
}

function send(response, status, contentType, body) {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

function sendJson(response, value, status = 200) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/projects') {
    sendJson(response, { projects: await listProjects() });
    return;
  }
  if (url.pathname === '/api/summary') {
    sendJson(response, await getRepositorySummary(resolveProject(url.searchParams.get('project'))));
    return;
  }
  if (url.pathname === '/api/commits') {
    sendJson(response, await getCommits(url));
    return;
  }
  if (url.pathname.startsWith('/api/commit/')) {
    const hash = decodeURIComponent(url.pathname.slice('/api/commit/'.length));
    sendJson(response, await getCommitDetails(url, hash));
    return;
  }
  const fileName = webFiles.get(url.pathname);
  if (fileName) {
    const filePath = path.join(scriptDirectory, fileName);
    const contentType = fileName.endsWith('.html') ? 'text/html; charset=utf-8'
      : fileName.endsWith('.css') ? 'text/css; charset=utf-8'
        : 'application/javascript; charset=utf-8';
    send(response, 200, contentType, await readFile(filePath));
    return;
  }
  sendJson(response, { error: 'Not found' }, 404);
}

async function main() {
  await mkdir(storeDirectory, { recursive: true });
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local Git web viewer: http://127.0.0.1:${port}`);
    console.log(`Repository store: ${storeDirectory}`);
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
