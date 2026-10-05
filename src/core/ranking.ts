/**
 * 搜索结果相关性排序。
 *
 * 借鉴 semble 的 noise-penalty 思路：搜索结果按“文件相关性”排序，让源码实现
 * 排在测试、示例、mock、兼容垫片之前，而不是按路径字母序平铺。排序只依赖路径
 * 与匹配行文本，纯函数、无副作用，前后端各保留一份同构实现。
 */

// 测试目录/文件：最重的路径降权。
const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|spec|testing|unittest|unittests|testdata|fixtures?)(?:\/|$)/i;
// 测试文件：覆盖 test_foo / foo_test / foo.test / foo_spec / FooTest / foo_suite /
// test_helpers 等常见命名（借鉴 semble 的 _TEST_FILE_RE，按语言归纳的通式）。
const TEST_FILE_RE =
  /(?:^|\/)(?:[^/]*(?:_test|\.test|\.spec|_spec|Tests?|_suite|Suite|_helper|Helper)\.[^/]+|test_[^/]+\.[^/]+|test_helpers?[^/]*\.[^/]+)(?:\/|$)/i;
// mock / stub / fake。
const MOCK_RE = /(?:^|\/)(?:[^/]*\.?mock[^/]*|[^/]*\.?stub[^/]*|[^/]*\.?fake[^/]*)(?:\/|$)/i;
// 示例代码。
const EXAMPLE_RE = /(?:^|\/)(?:examples?|samples?|demos?)(?:\/|$)/i;
// 兼容/旧代码。
const COMPAT_RE = /(?:^|\/)(?:compat|_compat|legacy|_legacy|old|deprecated)(?:\/|$)/i;
// re-export / 包元数据文件（如 __init__.py、package-info.java）：含类型信息但通常
// 只是转发，命中价值低于真正的实现文件。
const REEXPORT_RE =
  /(?:^|\/)(?:__init__|package-info|barrel)\.(?:py|java|js|ts|mjs|cjs|jsx|tsx)$/i;
// 类型声明存根 / 压缩产物 / 生成代码。
const DECL_RE = /\.d\.ts$/i;
const MIN_RE = /\.min\.(?:js|css)$/i;
const GENERATED_RE = /(?:^|\/)generated(?:\/|$)/i;
// 构建产物目录（通常已被 exclude，作为兜底）。
const BUILD_DIR_RE = /(?:^|\/)(?:dist|build|out|target|\.next)(?:\/|$)/i;
const NODE_MODULES_RE = /(?:^|\/)node_modules(?:\/|$)/i;

// 各噪声类别对应的乘性权重；rank 越接近 1 越靠前。
const PATH_PENALTIES: ReadonlyArray<{ re: RegExp; factor: number }> = [
  { re: TEST_DIR_RE, factor: 0.2 },
  { re: TEST_FILE_RE, factor: 0.2 },
  { re: REEXPORT_RE, factor: 0.5 },
  { re: MOCK_RE, factor: 0.3 },
  { re: EXAMPLE_RE, factor: 0.3 },
  { re: COMPAT_RE, factor: 0.3 },
  { re: DECL_RE, factor: 0.5 },
  { re: MIN_RE, factor: 0.5 },
  { re: GENERATED_RE, factor: 0.5 },
  { re: BUILD_DIR_RE, factor: 0.3 },
  { re: NODE_MODULES_RE, factor: 0.2 }
];

// 定义行关键字：匹配行以这些关键字声明符号（如 class Foo、def foo、#define X）。
const DEFINITION_KEYWORD_RE = /(?:^|[^\w])(?:class|struct|enum|interface|typedef|namespace|module|trait|record|def|fn|func|function|proc|#define)(?:\s+|\(|:)/i;

// 源码文件含定义行时的额外提升，只对无噪声标记（rank 保持 1）的文件生效，
// 避免把测试/示例文件的“定义”抬到源码实现之上。
const DEFINITION_BOOST = 0.2;
// “被查询符号的定义”额外提升：定义行同时包含被查符号时，说明该文件正是该符号的
// 实现/声明源，比泛化的“任意定义行”更值得靠前。借鉴 semble 的 _chunk_defines_symbol。
const SYMBOL_DEFINITION_BOOST = 0.35;

// 多命中一致性抬升：一个文件内命中行数越多，越可能是相关主题文件（而非孤立引用）。
// 只对无噪声源码生效，命中数 2~8 线性抬升到 +MATCH_BOOST_MAX，超过 8 封顶，
// 避免“命中上千行的泛化/数据文件”无限霸榜。
const MATCH_BOOST_MAX = 0.1;
const MATCH_BOOST_MIN_COUNT = 2;
const MATCH_BOOST_MAX_COUNT = 8;

export type RankableFile = {
  relativePath?: string;
  path?: string;
  matches?: ReadonlyArray<{ preview?: string }>;
};

/**
 * 计算单个文件的基础路径权重：命中任一噪声类别即乘性降权，返回 [0,1]。
 * 相对路径中的反斜杠统一归一化为正斜杠再匹配。
 */
export function computeFileRank(relativePath: string): number {
  const normalized = String(relativePath).replace(/\\/gu, '/');
  let rank = 1.0;
  for (const penalty of PATH_PENALTIES) {
    if (penalty.re.test(normalized)) {
      rank *= penalty.factor;
    }
  }
  return rank;
}

/**
 * 判断一行文本是否像“定义声明行”。严格匹配强定义关键字，避免把普通引用误判。
 */
export function isDefinitionLine(preview: string): boolean {
  return DEFINITION_KEYWORD_RE.test(String(preview));
}

/**
 * 判断一行文本是否是“被查询符号的定义行”：既是定义行，又包含被查符号名。
 * 被查符号取原始文本做子串匹配（区分大小写），避免把仅引用该符号的普通行误判。
 */
export function isSymbolDefinitionLine(preview: string, query: string): boolean {
  const symbol = String(query ?? '').trim();
  if (!symbol) {
    return false;
  }
  return isDefinitionLine(preview) && String(preview).includes(symbol);
}

/**
 * 计算多命中一致性抬升量：命中数低于阈值返回 0，2~8 条线性抬升，超过封顶值封顶。
 */
function computeMatchBoost(matchCount: number): number {
  if (matchCount < MATCH_BOOST_MIN_COUNT) {
    return 0;
  }
  const capped = Math.min(matchCount, MATCH_BOOST_MAX_COUNT);
  return (
    (MATCH_BOOST_MAX * (capped - MATCH_BOOST_MIN_COUNT + 1)) /
    (MATCH_BOOST_MAX_COUNT - MATCH_BOOST_MIN_COUNT + 1)
  );
}

/**
 * 计算文件最终相关性 = 基础路径权重 + 无噪声源码时的（定义提升 + 被查符号定义提升 +
 * 多命中一致性抬升）。三类提升都只作用在 rank 保持 1 的源码文件之间，不影响噪声文件
 * 的降权。query 可选：提供时优先识别“定义被查符号”的文件。
 */
export function computeFileScore(file: RankableFile, query?: string): number {
  const base = computeFileRank(file.relativePath ?? file.path ?? '');
  if (base !== 1.0) {
    return base;
  }
  const matches = file.matches ?? [];
  let score = base;
  const symbol = String(query ?? '').trim();
  const hasSymbolDefinition = symbol
    ? matches.some((match) => isSymbolDefinitionLine(match.preview ?? '', symbol))
    : false;
  const hasDefinition = matches.some((match) => isDefinitionLine(match.preview ?? ''));
  if (hasSymbolDefinition) {
    // 定义被查符号的文件优先级最高；普通定义行不再叠加，避免把两者重复累加。
    score += SYMBOL_DEFINITION_BOOST;
  } else if (hasDefinition) {
    score += DEFINITION_BOOST;
  }
  score += computeMatchBoost(matches.length);
  return score;
}

/**
 * 结果文件比较器：相关性分数高者在前，分数相同再按路径字母序保持稳定顺序。
 * query 可选，透传给 computeFileScore 用于“被查符号定义优先”。
 */
export function compareSearchFiles(
  left: RankableFile,
  right: RankableFile,
  query?: string
): number {
  const scoreDiff = computeFileScore(right, query) - computeFileScore(left, query);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  return String(left.relativePath ?? left.path ?? '').localeCompare(
    String(right.relativePath ?? right.path ?? '')
  );
}
