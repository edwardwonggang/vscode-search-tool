export type SearchOptions = {
  requestId?: number;
  query: string;
  fileQuery?: string;
  include: string;
  exclude: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  definitionMode?: boolean;
  triggerSource?: 'input' | 'enter' | 'toggle' | 'restore' | 'connection' | 'history';
};

export type SearchSettings = {
  remoteHost: string;
  remotePort: number;
  remoteUsername: string;
  remotePassword: string;
  remoteSearchPath: string;
  inferredRemoteSearchPath?: string;
  includeGlobs: string[];
  excludeGlobs: string[];
};

export type SearchMatch = {
  path: string;
  uri?: string;
  relativePath?: string;
  repositoryRelativePath?: string;
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  symbolName?: string;
};

export type TranslationRow = {
  key: string;
  en: string;
  zhCN: string;
};
