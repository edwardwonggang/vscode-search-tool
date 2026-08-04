import type { Client } from 'ssh2';
import * as posixPath from 'path/posix';
import type { SearchMatch, SearchOptions, SearchSettings } from '../core/types';
import type { SearchResultStore } from '../search/SearchResultStore';
import type { TranslationService } from '../i18n/TranslationService';
import type { RemoteExecutor } from '../remote/RemoteExecutor';
import type { RemoteToolInstaller } from '../remote/RemoteToolInstaller';
import type { ResolvedSearchRepository, WorkspaceResolver } from '../workspace/WorkspaceResolver';
import type { SessionLogger } from '../session/SessionLogger';
import { parseTagLine } from './ctags';
import { buildExecutableVersionCommand } from '../remote/commands';
import type { SearchSession } from '../session/SearchSession';
import type { WebviewMessageRouter } from '../search/WebviewMessageRouter';
import type { ConnectionController } from '../session/ConnectionController';
import { createDefinitionResultPathFilter } from '../core/glob';
import { StreamingLineProcessor } from '../search/StreamingLineProcessor';
import { filterRipgrepStderr, isIgnorableRipgrepFailure } from '../session/rgDiagnostics';
import { TAG_PROBE_PREFIX, parseTagProbe } from './tagProbe';
import { buildTagProbeAndSearchCommand, buildTagSearchCommand } from './tagSearch';
import {
  TAG_INDEX_CTAGS_ARGS_KEY,
  buildCtagsRebuildCommand,
  buildGitHeadCommand,
  createTagIndexMeta,
  getTagIndexPaths
} from './TagIndex';
const CTAGS_PROGRESS_REFRESH_MS = 500;

export type DefinitionSearchConfig = {
  contextLines: number;
  threads: number;
  resultRefreshMs: number;
  definitionExcludeGlobs: string[];
};

export class DefinitionSearch {
  constructor(
    private readonly session: SearchSession,
    private readonly resultStore: SearchResultStore,
    private readonly connectionController: ConnectionController,
    private readonly workspaceResolver: WorkspaceResolver,
    private readonly translationService: TranslationService,
    private readonly remoteExecutor: RemoteExecutor,
    private readonly remoteToolInstaller: RemoteToolInstaller,
    private readonly logger: SessionLogger,
    private readonly config: DefinitionSearchConfig
  ) {}

  public async execute(
    token: number,
    options: SearchOptions,
    settings: SearchSettings,
    repository: ResolvedSearchRepository,
    messageRouter: WebviewMessageRouter,
    finalize = true,
    searchStartedAt = Date.now()
  ): Promise<boolean> {
    const query = options.query.trim();
    const startedAt = searchStartedAt;
    const remoteCwd = repository.remoteCwd;
    this.logger.log(`def-search#${token} start query="${query}" cwd="${remoteCwd}" session.current=${this.session.currentToken}`);
    this.logger.log(`def-search#${token} requestId=${options.requestId ?? 'none'} trigger=${options.triggerSource ?? 'unknown'}`);
    const definitionPathFilter = this.createResultPathFilter(options, settings);

    this.session.postState({
      type: 'state',
      running: true,
      summary: await this.translationService.translate('def_searching'),
      ctagsInProgress: false
    });

    try {
      this.logger.log(`def-search#${token} getting SSH client`);
      this.session.postPhase('Connecting to SSH...');
      const client = await this.connectionController.getOrCreateClient(settings);
      if (!this.session.isCurrent(token)) {
        this.logger.log(`def-search#${token} cancelled after getting client`);
        return false;
      }

      // 合并探针与扫描为一次 SSH 往返：探针元数据（git 根/rg/ctags/tags/git HEAD）先输出，
      // tags 存在时同一条流内继续输出该符号的匹配块，减少慢链路上的往返次数。
      this.logger.log(`def-search#${token} running combined probe + tag search`);
      this.session.postPhase('Searching definitions...');
      const probeLines: string[] = [];
      let probeGitTop = '';
      await this.streamTagSearch(
        client,
        buildTagProbeAndSearchCommand(
          remoteCwd,
          this.remoteToolInstaller.remoteRgPath,
          this.remoteToolInstaller.remoteCtagsPath,
          query
        ),
        token,
        query,
        repository,
        () => probeGitTop,
        startedAt,
        definitionPathFilter,
        (line) => {
          probeLines.push(line);
          if (line.startsWith(`${TAG_PROBE_PREFIX}gitTop=`)) {
            probeGitTop = line.slice(`${TAG_PROBE_PREFIX}gitTop=`.length);
          }
        }
      );
      if (!this.session.isCurrent(token)) {
        this.logger.log(`def-search#${token} cancelled after combined probe+search`);
        return false;
      }
      const probe = parseTagProbe(probeLines.join('\n'));
      if (!probe || !probe.gitTop || probe.insideWorkTree !== 'true') {
        throw new Error(await this.translationService.translate('err_not_git_workspace'));
      }
      const gitTop = probe.gitTop;
      this.logger.log(
        `def-search#${token} probe gitTop="${gitTop}" rg=${probe.rgVersion ? 'present' : 'missing'} ctags=${probe.ctagsVersion ? 'present' : 'missing'} tags=${probe.tagsExists ? 'y' : 'n'}`
      );
      this.logger.log(`def-search#${token} gitTop="${gitTop}"`);

      const tagsPath = getTagIndexPaths(gitTop).tagsPath;
      this.logger.log(`def-search#${token} tagsPath=${tagsPath}`);
      if (!probe.tagsExists) {
        this.logger.log(`def-search#${token} running ctags build`);
        this.session.postPhase('Checking remote ctags...');
        const ctagsPath = await this.remoteToolInstaller.ensureCtags(
          client,
          await this.translationService.translate('err_ctags_missing'),
          probe.ctagsVersion
        );
        if (!this.session.isCurrent(token)) {
          return false;
        }
        this.logger.log(`def-search#${token} ctags at ${ctagsPath}`);
        await this.runRemoteCtagsBuild(client, ctagsPath, gitTop, token, messageRouter, probe.gitHead, probe.ctagsVersion);
        if (!this.session.isCurrent(token)) {
          return false;
        }
        // tags 缺失时重建索引，然后对新建的索引执行一次纯扫描。
        const tagsDir = posixPath.dirname(tagsPath);
        const tagsBase = posixPath.basename(tagsPath);
        this.logger.log(`def-search#${token} searching tags after rebuild query="${query}" in ${tagsBase}`);
        this.session.postPhase('Searching tag index...');
        await this.streamTagSearch(
          client,
          buildTagSearchCommand(tagsDir, tagsBase, query),
          token,
          query,
          repository,
          tagsDir,
          startedAt,
          definitionPathFilter
        );
        if (!this.session.isCurrent(token)) {
          return false;
        }
      }

      this.session.flushResults();
      if (!finalize) {
        return true;
      }
      this.session.stopProgress();

      this.logger.log(`def-search#${token} done store size=${this.resultStore.size} total=${this.resultStore.totalMatches()}`);
      const elapsedMs = Date.now() - startedAt;
      const fileCount = this.resultStore.size;
      const total = this.resultStore.totalMatches();
      const summary = total === 0
        ? (await this.translationService.translate('def_no_results')) + ` (${elapsedMs} ms)`
        : `${fileCount} files, ${total} results (${elapsedMs} ms)`;
      this.session.postState({ type: 'state', running: false, summary, elapsedMs, ctagsInProgress: false });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.log(`def-search#${token} error: ${message}`);
      if (this.session.isCurrent(token)) {
        this.session.stopProgress();
        this.session.postState({ type: 'state', running: false, error: message, ctagsInProgress: false });
      }
      return false;
    }
  }

  private createResultPathFilter(options: SearchOptions, settings: SearchSettings): (relativePath: string) => boolean {
    return createDefinitionResultPathFilter(options, settings, this.config.definitionExcludeGlobs);
  }

  private parseTagResultLine(
    line: string,
    query: string,
    repository: ResolvedSearchRepository,
    tagsBaseRemote: string
  ): SearchMatch | null {
    this.logger.debug(`parseTagResultLine query="${query}" line="${line.substring(0, 80)}..."`);
    const parsed = parseTagLine(line, query, tagsBaseRemote);
    if (!parsed) {
      this.logger.debug('parseTagResultLine skipped: no ctags match');
      return null;
    }
    let target;
    try {
      target = this.createTargetFromRemotePath(repository, parsed.remoteFileAbs);
    } catch (error) {
      this.logger.debug(`parseTagResultLine skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    return {
      path: target.legacyPath,
      uri: target.uriString,
      relativePath: target.relativePath,
      repositoryRelativePath: target.repositoryRelativePath,
      line: parsed.line,
      column: parsed.column,
      endColumn: parsed.endColumn,
      preview: parsed.preview || parsed.name,
      symbolName: parsed.name
    };
  }

  private createTargetFromRemotePath(repository: ResolvedSearchRepository, remoteFileAbs: string) {
    const relativePath = this.getRelativeRemotePath(remoteFileAbs, repository.remoteCwd);
    if (relativePath !== undefined) {
      return this.workspaceResolver.createWorkspaceTarget(repository, relativePath);
    }
    throw new Error('Remote path is outside the workspace root.');
  }

  private getRelativeRemotePath(remoteFileAbs: string, remoteCwd: string): string | undefined {
    const normalizedFile = remoteFileAbs.replace(/\\/gu, '/').replace(/\/+/gu, '/');
    const normalizedCwd = remoteCwd.replace(/\\/gu, '/').replace(/\/+/gu, '/').replace(/\/$/u, '');
    if (normalizedFile.startsWith(normalizedCwd + '/')) {
      return normalizedFile.slice(normalizedCwd.length + 1);
    }
    return undefined;
  }

  /**
   * 流式执行 tags 搜索命令并增量写入结果存储。command 可以是“探针+扫描”合并命令
   * 或重建后的纯扫描命令；tagsDir 在合并命令场景是惰性取值的 git 根（探针解析后才有）。
   * 搜索命令不设墙钟超时：长索引扫描由用户切换/取消来终止。
   */
  private async streamTagSearch(
    client: Client,
    command: string,
    token: number,
    query: string,
    repository: ResolvedSearchRepository,
    tagsDir: string | (() => string),
    startedAt: number,
    definitionPathFilter: (relativePath: string) => boolean,
    onProbeLine?: (line: string) => void
  ): Promise<void> {
    let totalLines = 0;
    let firstResultLogged = false;
    const lineBuffer = new StreamingLineProcessor({
      shouldContinue: () => this.session.isCurrent(token),
      onLine: (line) => {
        if (!this.session.isCurrent(token)) {
          return;
        }
        if (onProbeLine && line.startsWith(TAG_PROBE_PREFIX)) {
          onProbeLine(line);
          return;
        }
        totalLines += 1;
        const resolvedTagsDir = typeof tagsDir === 'function' ? tagsDir() : tagsDir;
        if (!resolvedTagsDir) {
          return;
        }
        const m = this.parseTagResultLine(line, query, repository, resolvedTagsDir);
        if (!m) {
          return;
        }
        const filterRelativePath = m.repositoryRelativePath ?? m.relativePath ?? m.path;
        if (!definitionPathFilter(filterRelativePath)) {
          return;
        }
        const relativePath = m.relativePath ?? filterRelativePath;
        const cacheKey = m.uri ?? m.path;
        this.resultStore.addMatch(cacheKey, m.path, relativePath, m);
        this.session.recordMatch();
        if (!firstResultLogged) {
          firstResultLogged = true;
          this.logger.log(`def-search#${token} first result elapsed=${Date.now() - startedAt} ms`);
          this.session.startProgress('content');
        }
        this.session.scheduleResultPush('content');
      }
    });
    const rg = await this.remoteExecutor.execStreamingWithExitCode(client, command, {
      trackAsActive: true,
      collectStdout: false,
      timeoutMs: 0,
      onStdout: (chunk) => lineBuffer.push(chunk)
    });
    if (!firstResultLogged) {
      this.session.startProgress('content');
    }
    await lineBuffer.flush();
    this.logger.log(`def-search#${token} stream stats=${JSON.stringify(lineBuffer.stats)}`);
    this.logger.log(`def-search#${token} rg done code=${rg.code} stdoutLines=${totalLines}`);
    if (!this.session.isCurrent(token)) {
      return;
    }
    const stderr = filterRipgrepStderr(rg.stderr);
    if (stderr.ignoredPermissionDeniedCount > 0) {
      this.logger.log(`def-search#${token} ignored ${stderr.ignoredPermissionDeniedCount} ripgrep permission-denied diagnostics`);
    }
    if (rg.code === 141) {
      this.logger.log(`def-search#${token} ignored ripgrep code=141 after stream close`);
      return;
    }
    if (isIgnorableRipgrepFailure(rg.code, rg.stderr)) {
      this.logger.log(`def-search#${token} ignored ripgrep code=${rg.code} with permission-denied diagnostics only`);
    } else if (rg.code !== 0 && rg.code !== 1) {
      throw new Error((stderr.visibleStderr && stderr.visibleStderr.slice(0, 300)) || `ripgrep exited with code ${String(rg.code)}`);
    }
  }

  private async runRemoteCtagsBuild(
    client: Client,
    ctagsPath: string,
    gitTop: string,
    token: number,
    messageRouter: WebviewMessageRouter,
    knownGitHead = '',
    knownCtagsVersion = ''
  ): Promise<void> {
    const buildSummary = await this.translationService.translate('ctags_building');
    const buildFailedMessage = await this.translationService.translate('ctags_build_failed');
    const buildDoneMessage = await this.translationService.translate('ctags_build_done');

    this.session.postState({ type: 'state', running: true, summary: buildSummary, ctagsInProgress: true });
    const tagIndexPaths = getTagIndexPaths(gitTop);
    // 探针已返回 git HEAD 与 ctags 版本时直接复用，避免再发两次远端 exec。
    const gitHead = knownGitHead || await this.getGitHead(client, gitTop);
    const ctagsVersion = knownCtagsVersion || await this.getCtagsVersion(client, ctagsPath);
    const command = buildCtagsRebuildCommand(
      ctagsPath,
      gitTop,
      tagIndexPaths,
      createTagIndexMeta({
        gitTop,
        gitHead,
        ctagsVersion,
        ctagsArgsKey: TAG_INDEX_CTAGS_ARGS_KEY
      })
    );

    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        this.session.setActiveChannel(stream);
        let acc = '';
        let lastProgressAt = 0;

        stream.on('data', (c: Buffer | string) => {
          acc += Buffer.isBuffer(c) ? c.toString('utf8') : c;
          if (!this.session.isCurrent(token)) {
            return;
          }
          const now = Date.now();
          if (now - lastProgressAt < CTAGS_PROGRESS_REFRESH_MS) {
            return;
          }
          lastProgressAt = now;
          const parts = acc.split(/\r?\n/u);
          const last = parts[Math.max(0, parts.length - 2)] || parts[0] || '';
          const tail = last.length > 90 ? last.slice(-90) : last;
          this.session.postState({
            type: 'state',
            running: true,
            ctagsInProgress: true,
            summary: tail.trim() ? `${buildSummary} - ${tail.trim()}` : buildSummary
          });
        });

        stream.stderr.on('data', (c: Buffer | string) => {
          acc += Buffer.isBuffer(c) ? c.toString('utf8') : c;
        });

        stream.on('close', (code: number | undefined) => {
          this.session.setActiveChannel(undefined, stream);
          if (!this.session.isCurrent(token)) {
            resolve();
            return;
          }
          if (code !== 0 && code !== undefined) {
            const logText = acc.trim().slice(0, 500);
            reject(new Error(logText || buildFailedMessage));
          } else {
            this.session.postState({
              type: 'state',
              running: true,
              ctagsInProgress: false,
              summary: buildDoneMessage
            });
            resolve();
          }
        });

        stream.on('error', (e: Error) => {
          this.session.setActiveChannel(undefined, stream);
          reject(e);
        });
      });
    });
  }

  private async getGitHead(client: Client, gitTop: string): Promise<string> {
    const result = await this.remoteExecutor.execWithExitCode(client, buildGitHeadCommand(gitTop));
    return result.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
  }

  private async getCtagsVersion(client: Client, ctagsPath: string): Promise<string> {
    const result = await this.remoteExecutor.execWithExitCode(client, buildExecutableVersionCommand(ctagsPath));
    return result.stdout.split(/\r?\n/u)[0]?.trim() ?? '';
  }
}
