import { normalizeSearchPath } from '../core/glob';

export const MAX_GIT_DISCOVERY_DEPTH = 3;

export type GitDiscoveryEntry = {
  name: string;
  isDirectory: boolean;
};

export type GitDiscoveryFs = {
  isGitRepository(relativePath: string): Promise<boolean>;
  readDirectory(relativePath: string): Promise<GitDiscoveryEntry[]>;
};

export type DiscoveredGitRepository = {
  name: string;
  workspaceRelativePath: string;
};

// VS Code FileType values can combine Directory with SymbolicLink.
export function isDirectoryFileType(fileType: number, directoryFlag: number): boolean {
  return (fileType & directoryFlag) !== 0;
}

export function isGitFileMarkerText(text: string): boolean {
  return /^gitdir:\s*\S+/iu.test(text.trim());
}

export async function discoverGitRepositories(
  fs: GitDiscoveryFs,
  maxDepth = MAX_GIT_DISCOVERY_DEPTH
): Promise<DiscoveredGitRepository[]> {
  const repositories: DiscoveredGitRepository[] = [];

  async function visit(relativePath: string, depth: number): Promise<void> {
    const normalizedRelativePath = normalizeSearchPath(relativePath);
    if (await fs.isGitRepository(normalizedRelativePath)) {
      repositories.push({
        name: normalizedRelativePath ? lastPathSegment(normalizedRelativePath) : '',
        workspaceRelativePath: normalizedRelativePath
      });
      return;
    }

    if (depth >= maxDepth) {
      return;
    }

    let entries: GitDiscoveryEntry[];
    try {
      entries = await fs.readDirectory(normalizedRelativePath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (shouldSkipDiscoveryEntry(entry)) {
        continue;
      }
      const childRelativePath = normalizedRelativePath ? `${normalizedRelativePath}/${entry.name}` : entry.name;
      await visit(childRelativePath, depth + 1);
    }
  }

  await visit('', 0);
  repositories.sort((left, right) => left.workspaceRelativePath.localeCompare(right.workspaceRelativePath));
  return repositories;
}

function shouldSkipDiscoveryEntry(entry: GitDiscoveryEntry): boolean {
  if (!entry.isDirectory) {
    return true;
  }
  return [
    '.git',
    'node_modules',
    '.vscode',
    '.idea',
    '.tmp-context'
  ].includes(entry.name);
}

function lastPathSegment(relativePath: string): string {
  const normalized = normalizeSearchPath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
}
