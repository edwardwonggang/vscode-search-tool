import * as posixPath from 'path/posix';
import { shellEscape } from '../core/shell';

export const TAGS_FILE_NAME = 'tags';
export const TAGS_TMP_FILE_NAME = 'tags.tmp';
export const TAGS_META_FILE_NAME = 'tags.meta.json';
export const TAGS_SPARSE_INDEX_FILE_NAME = 'tags.sidx';
export const TAG_INDEX_SCHEMA_VERSION = 2;
export const TAG_INDEX_SAMPLE_BYTES = 1048576;
export const TAG_INDEX_CTAGS_ARGS_KEY = '--sort=yes --tag-relative=yes --fields=+n --c-kinds=+defgmpstuv --c++-kinds=+cdefgmpstuv --exclude=tags --exclude=tags.tmp --exclude=tags.meta.json --exclude=tags.sidx* sparse-index-v1';
export const DEFAULT_TAG_AUTO_REFRESH_MINUTES = 30;
/** 工作区有未提交改动时，距上次索引构建至少超过该时长（毫秒）才触发重建，避免每次编辑都全量重建。 */
export const DEFAULT_DIRTY_REFRESH_MS = 30000;

export const CTAGS_EXCLUDE_PATTERNS = [
  '*.a',
  '*.bin',
  '*.bmp',
  '*.bz2',
  '*.dll',
  '*.elf',
  '*.exe',
  '*.gif',
  '*.gz',
  '*.hex',
  '*.iso',
  '*.jpg',
  '*.jpeg',
  '*.lib',
  '*.o',
  '*.obj',
  '*.pdf',
  '*.png',
  '*.so',
  '*.tar',
  '*.tgz',
  '*.zip',
  '*.7z',
  'node_modules'
] as const;

export type TagIndexPaths = {
  tagsDir: string;
  tagsPath: string;
  indexPath: string;
  tmpPath: string;
  metaPath: string;
};

export type TagIndexMeta = {
  schemaVersion: number;
  gitTop: string;
  gitHead: string;
  ctagsVersion: string;
  ctagsArgsKey: string;
  builtAtMs: number;
};

export type TagIndexRefreshInput = {
  tagsExists: boolean;
  meta?: TagIndexMeta;
  gitTop: string;
  gitHead: string;
  ctagsVersion: string;
  ctagsArgsKey: string;
  refreshIntervalMs: number;
  nowMs: number;
  /** 工作区是否存在未提交改动（git 工作区脏）。缺省视为无改动。 */
  workspaceDirty?: boolean;
  /** 工作区脏时允许触发重建的阈值（毫秒），缺省用 DEFAULT_DIRTY_REFRESH_MS；<=0 表示不因 dirty 重建。 */
  dirtyRefreshMs?: number;
};

export type TagIndexRefreshDecision = {
  refresh: boolean;
  reason: string;
};

export function getTagIndexPaths(gitTop: string): TagIndexPaths {
  const tagsDir = gitTop.replace(/\/+$/u, '');
  return {
    tagsDir,
    tagsPath: posixPath.join(tagsDir, TAGS_FILE_NAME),
    indexPath: posixPath.join(tagsDir, TAGS_SPARSE_INDEX_FILE_NAME),
    tmpPath: posixPath.join(tagsDir, TAGS_TMP_FILE_NAME),
    metaPath: posixPath.join(tagsDir, TAGS_META_FILE_NAME)
  };
}

export function createTagIndexMeta(input: Omit<TagIndexMeta, 'schemaVersion' | 'builtAtMs'>, nowMs = Date.now()): TagIndexMeta {
  return {
    schemaVersion: TAG_INDEX_SCHEMA_VERSION,
    gitTop: input.gitTop,
    gitHead: input.gitHead,
    ctagsVersion: input.ctagsVersion,
    ctagsArgsKey: input.ctagsArgsKey,
    builtAtMs: nowMs
  };
}

export function parseTagIndexMeta(text: string): TagIndexMeta | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<TagIndexMeta>;
    if (
      typeof parsed.schemaVersion !== 'number' ||
      typeof parsed.gitTop !== 'string' ||
      typeof parsed.gitHead !== 'string' ||
      typeof parsed.ctagsVersion !== 'string' ||
      typeof parsed.ctagsArgsKey !== 'string' ||
      typeof parsed.builtAtMs !== 'number'
    ) {
      return undefined;
    }
    return {
      schemaVersion: parsed.schemaVersion,
      gitTop: parsed.gitTop,
      gitHead: parsed.gitHead,
      ctagsVersion: parsed.ctagsVersion,
      ctagsArgsKey: parsed.ctagsArgsKey,
      builtAtMs: parsed.builtAtMs
    };
  } catch {
    return undefined;
  }
}

export function decideTagIndexRefresh(input: TagIndexRefreshInput): TagIndexRefreshDecision {
  if (!input.tagsExists) {
    // tags 缺失也返回构建：后台自动刷新负责预热索引，避免用户首次跳转定义
    // 时现场全量构建 tags 造成明显等待。
    return { refresh: true, reason: 'tags-missing' };
  }
  if (!input.meta) {
    return { refresh: true, reason: 'meta-missing' };
  }
  if (input.meta.schemaVersion !== TAG_INDEX_SCHEMA_VERSION) {
    return { refresh: true, reason: 'schema-changed' };
  }
  if (input.meta.gitTop !== input.gitTop) {
    return { refresh: true, reason: 'git-root-changed' };
  }
  if (input.meta.gitHead !== input.gitHead) {
    return { refresh: true, reason: 'git-head-changed' };
  }
  if (input.meta.ctagsVersion !== input.ctagsVersion) {
    return { refresh: true, reason: 'ctags-version-changed' };
  }
  if (input.meta.ctagsArgsKey !== input.ctagsArgsKey) {
    return { refresh: true, reason: 'ctags-args-changed' };
  }
  if (input.refreshIntervalMs > 0 && input.nowMs - input.meta.builtAtMs >= input.refreshIntervalMs) {
    return { refresh: true, reason: 'refresh-interval' };
  }
  // 工作区有未提交改动时，新写代码（未 commit）的符号在旧索引里查不到。
  // 用独立阈值 dirtyRefreshMs 节流，避免每次编辑都触发全量重建；默认 30 秒后仍脏才重建。
  if (input.workspaceDirty) {
    const dirtyMs = input.dirtyRefreshMs ?? DEFAULT_DIRTY_REFRESH_MS;
    if (dirtyMs > 0 && input.nowMs - input.meta.builtAtMs >= dirtyMs) {
      return { refresh: true, reason: 'workspace-dirty' };
    }
  }
  return { refresh: false, reason: 'fresh' };
}

export function buildGitHeadCommand(gitTop: string): string {
  return `cd ${shellEscape(gitTop)} && git rev-parse HEAD`;
}

export function buildReadTagIndexMetaCommand(metaPath: string): string {
  return `if test -f ${shellEscape(metaPath)}; then cat ${shellEscape(metaPath)}; fi`;
}
export function buildSidxAndMetaShellBlock(paths: TagIndexPaths, meta: TagIndexMeta): string[] {
  const metaJson = JSON.stringify(meta);
  const indexTmpPath = `${paths.indexPath}.tmp`;
  const indexPartsPath = `${paths.indexPath}.parts`;
  return [
    `rm -f ${shellEscape(paths.metaPath)}`,
    `indexTmp=${shellEscape(indexTmpPath)}.$$`,
    `partsDir=${shellEscape(indexPartsPath)}.$$`,
    `rm -f "$indexTmp"`,
    `rm -rf "$partsDir"`,
    `if command -v split >/dev/null 2>&1; then`,
    `  if mkdir -p "$partsDir" && split -b ${TAG_INDEX_SAMPLE_BYTES} -d -a 8 ${shellEscape(paths.tagsPath)} "$partsDir/chunk" && : > "$indexTmp"; then`,
    `    block=0`,
    `    for part in "$partsDir"/chunk*; do`,
    `      test -f "$part" || continue`,
    `      if test "$block" -eq 0; then`,
    `        name=$(LC_ALL=C awk -F '\\t' '$1 !~ /^!_TAG_/ && NF > 1 { print $1; exit }' "$part")`,
    `      else`,
    `        name=$(LC_ALL=C awk -F '\\t' 'NR == 1 { next } $1 !~ /^!_TAG_/ && NF > 1 { print $1; exit }' "$part")`,
    `      fi`,
    `      if test -n "$name"; then printf '%s\\t%s\\n' "$block" "$name" >> "$indexTmp"; fi`,
    `      block=$((block + 1))`,
    `    done`,
    `    mv -f "$indexTmp" ${shellEscape(paths.indexPath)} || rm -f ${shellEscape(paths.indexPath)}`,
    `  else`,
    `    rm -f "$indexTmp" ${shellEscape(paths.indexPath)}`,
    `  fi`,
    `else`,
    `  rm -f "$indexTmp" ${shellEscape(paths.indexPath)}`,
    `fi`,
    `rm -rf "$partsDir"`,
    `metaTmp=${shellEscape(`${paths.metaPath}.tmp`)}.$$`,
    `printf %s ${shellEscape(metaJson)} > "$metaTmp"`,
    `mv -f "$metaTmp" ${shellEscape(paths.metaPath)}`
  ];
}


export const TAG_INCREMENTAL_MAX_FILES = 200;

/**
 * 构建"增量后台索引"重建命令（借鉴 clangd background index 的"只重建变更"
 * 思想，但完全基于 git + ctags，不依赖 compile_commands.json）。
 *
 * 排除 tags* 索引文件自身），只对仍存在的变更文件做局部 ctags，再把旧 tags
 * 中属于这些文件的旧符号删除、追加局部重建结果并用 LC_ALL=C sort 整体重排
 * （保证 readtags 二分与 tags.sidx 稀疏索引依赖的严格排序不破坏），最后重建
 * tags.sidx 与 tags.meta.json。
 *
 * 输出约定（供调用方判定结果）：
 *   - stdout 含 CTAGS_INCREMENTAL:noop  → 无变更，跳过（exit 0）
 *   - stdout 含 CTAGS_INCREMENTAL:ok    → 增量重建成功（exit 0）
 *   - stdout 含 CTAGS_INCREMENTAL:full  → 应回退全量重建（exit 0，调用方据此
 *     执行 buildCtagsRebuildCommand；原因：变更文件过多，或存在带引号/非可打印
 *     字符的复杂路径，增量合并不安全）
 *   - 其他非 0 退出码 → 增量失败，调用方应回退全量重建。
 *
 * 不改变任何现有重建路径的默认行为；只有调用方显式调用本命令并解析输出才会
 * 走增量。
 */
export function buildCtagsIncrementalCommand(
  ctagsPath: string,
  gitTop: string,
  paths: TagIndexPaths,
  meta: TagIndexMeta,
  maxFiles = TAG_INCREMENTAL_MAX_FILES
): string {
  const excludes = [
    TAGS_FILE_NAME,
    TAGS_TMP_FILE_NAME,
    TAGS_META_FILE_NAME,
    `${TAGS_SPARSE_INDEX_FILE_NAME}*`
  ].map((pattern) => `--exclude=${shellEscape(pattern)}`).join(' ');
  const incrPath = `${paths.tagsPath}.incr`;
  const incrTmpPath = `${incrPath}.tmp`;
  const filteredPath = `${paths.tagsPath}.filtered`;
  const mergedPath = `${paths.tagsPath}.merged`;
  // 局部单文件 ctags 必须用 --tag-relative=no（相对 cwd=gitTop）才能与全量
  // `ctags -R --tag-relative=yes -f gitTop/tags .` 的路径格式一致：yes 对显式
  // 文件参数会输出相对 tags 文件的意外绝对路径（如 ../private/tmp/...），no 则
  // 输出相对 cwd 的 src/f1.c。增量合并要求新旧符号路径基准完全一致。
  const ctagsArgs = `--sort=yes -f ${shellEscape(incrTmpPath)} --tag-relative=no --fields=+n --c-kinds=+defgmpstuv --c++-kinds=+cdefgmpstuv ${excludes}`;
  return [
    `cd ${shellEscape(gitTop)}`,
    // 收集变更源文件（含删除），排除 tags* 索引文件自身；检测复杂路径（引号/非可打印）→ 回退全量
    `changed=$(git status --porcelain | awk 'NF>1 { p=$2; if (p ~ /^tags(\.|$)/) next; if (p ~ /^"/ || p ~ /->/ || p ~ /[^[:print:]]/) { print "CTAGS_FULL"; exit } print p }' | sed '/^$/d')`,
    `if printf '%s\n' "$changed" | grep -q '^CTAGS_FULL$'; then echo 'CTAGS_INCREMENTAL:full'; exit 0; fi`,
    `count=$(printf '%s\n' "$changed" | sed '/^$/d' | wc -l | tr -d ' ')`,
    `if test -z "$changed"; then echo 'CTAGS_INCREMENTAL:noop'; exit 0; fi`,
    `if test "$count" -gt ${maxFiles}; then echo 'CTAGS_INCREMENTAL:full'; exit 0; fi`,
    // 对仍存在的变更文件做局部 ctags
    `: > ${shellEscape(incrPath)}`,
    `while IFS= read -r f; do if test -f "$f"; then ${shellEscape(ctagsPath)} ${ctagsArgs} "$f" && grep -v '^!_TAG_' ${shellEscape(incrTmpPath)} >> ${shellEscape(incrPath)}; fi; done <<EOF`,
    `$changed`,
    `EOF`,
    // 合并：删除旧 tags 中变更文件的旧符号 + 追加局部重建 + 整体排序
    `printf '%s\n' "$changed" > ${shellEscape(filteredPath)}`,
    `awk -F '\t' 'NR==FNR { del[$0]=1; next } $1 ~ /^!_TAG_/ { next } !($2 in del) { print }' ${shellEscape(filteredPath)} ${shellEscape(paths.tagsPath)} > ${shellEscape(mergedPath)}`,
    `{ cat ${shellEscape(mergedPath)}; cat ${shellEscape(incrPath)}; } | LC_ALL=C sort -k1,1 > ${shellEscape(`${mergedPath}.srt`)}`,
    `mv -f ${shellEscape(`${mergedPath}.srt`)} ${shellEscape(paths.tagsPath)}`,
    `rm -f ${shellEscape(incrPath)} ${shellEscape(incrTmpPath)} ${shellEscape(filteredPath)} ${shellEscape(mergedPath)}`,
    // 重建 sidx + meta
    ...buildSidxAndMetaShellBlock(paths, meta),
    `echo 'CTAGS_INCREMENTAL:ok'`
  ].join('\n');
}

export function buildCtagsRebuildCommand(ctagsPath: string, gitTop: string, paths: TagIndexPaths, meta: TagIndexMeta): string {
  const excludes = [
    ...CTAGS_EXCLUDE_PATTERNS,
    TAGS_FILE_NAME,
    TAGS_TMP_FILE_NAME,
    TAGS_META_FILE_NAME,
    `${TAGS_SPARSE_INDEX_FILE_NAME}*`
  ].map((pattern) => `--exclude=${shellEscape(pattern)}`).join(' ');
  const metaJson = JSON.stringify(meta);
  const indexTmpPath = `${paths.indexPath}.tmp`;
  const indexPartsPath = `${paths.indexPath}.parts`;
  return [
    `cd ${shellEscape(gitTop)}`,
    `rm -f ${shellEscape(paths.tmpPath)}`,
    `${shellEscape(ctagsPath)} -R --sort=yes -f ${shellEscape(paths.tmpPath)} --tag-relative=yes --fields=+n --c-kinds=+defgmpstuv --c++-kinds=+cdefgmpstuv ${excludes} .`,
    `mv -f ${shellEscape(paths.tmpPath)} ${shellEscape(paths.tagsPath)}`,
    `rm -f ${shellEscape(paths.metaPath)}`,
    `indexTmp=${shellEscape(indexTmpPath)}.$$`,
    `partsDir=${shellEscape(indexPartsPath)}.$$`,
    `rm -f "$indexTmp"`,
    `rm -rf "$partsDir"`,
    `if command -v split >/dev/null 2>&1; then`,
    `  if mkdir -p "$partsDir" && split -b ${TAG_INDEX_SAMPLE_BYTES} -d -a 8 ${shellEscape(paths.tagsPath)} "$partsDir/chunk" && : > "$indexTmp"; then`,
    `    block=0`,
    `    for part in "$partsDir"/chunk*; do`,
    `      test -f "$part" || continue`,
    `      if test "$block" -eq 0; then`,
    `        name=$(LC_ALL=C awk -F '\\t' '$1 !~ /^!_TAG_/ && NF > 1 { print $1; exit }' "$part")`,
    `      else`,
    `        name=$(LC_ALL=C awk -F '\\t' 'NR == 1 { next } $1 !~ /^!_TAG_/ && NF > 1 { print $1; exit }' "$part")`,
    `      fi`,
    `      if test -n "$name"; then printf '%s\\t%s\\n' "$block" "$name" >> "$indexTmp"; fi`,
    `      block=$((block + 1))`,
    `    done`,
    `    mv -f "$indexTmp" ${shellEscape(paths.indexPath)} || rm -f ${shellEscape(paths.indexPath)}`,
    `  else`,
    `    rm -f "$indexTmp" ${shellEscape(paths.indexPath)}`,
    `  fi`,
    `else`,
    `  rm -f "$indexTmp" ${shellEscape(paths.indexPath)}`,
    `fi`,
    `rm -rf "$partsDir"`,
    `metaTmp=${shellEscape(`${paths.metaPath}.tmp`)}.$$`,
    `printf %s ${shellEscape(metaJson)} > "$metaTmp"`,
    `mv -f "$metaTmp" ${shellEscape(paths.metaPath)}`
  ].join(' && ');
}
