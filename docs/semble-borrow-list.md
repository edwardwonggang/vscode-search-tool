# semble 值得借鉴的内容清单（对照 ripgreptool 评估）

> 本文整理 semble（MinishLab/semble）源代码中最值得借鉴的技术点，并逐一评估
> 对 ripgreptool（VS Code 扩展，远程 SSH 执行 rg/ctags，纯 TS，唯一依赖 ssh2）
> 的落地价值与可行性。源码已通过镜像 `ghfast.top` 下载到
> `D:\cursor_dev\semble_extracted\semble-main`。

## 一句话定位差异

- **semble**：本地**预建索引**（BM25 稀疏 + dense 语义 + 语法分块），查询 ~1ms，面向
  AI agent 用自然语言检索并返回精确代码片段，用 ~99% 更少 token。
- **ripgreptool**：远程**实时扫描**（每次跳转/搜索发一次 SSH 命令给 rg/ctags），无本地
  索引、无 Python、无 embedding 模型。

因此：**凡是"提升检索准确度/排序"的启发式都能直接借鉴；凡是"引入本地向量索引/
预建 BM25/语法解析"的都受限于现有架构与公司离线环境，需要权衡或分阶段。**

---

## 一、强烈建议直接借鉴（纯启发式，零新依赖，收益高）

### 1. 标识符 camelCase / snake_case 拆分（`tokens.py`）★ 最值钱

`tokenize()` 把查询和索引内容里的复合标识符拆成子 token，同时保留原完整 token：

- `HandlerStack` → `handlerstack` + `handler` + `stack`
- `my_func` → `my_func` + `my` + `func`
- `getHTTPResponse` → `get` + `http` + `response`
- `XMLParser` → `xml` + `parser`

原始完整 token 保留用于**精确匹配提升**，子 token 用于**部分匹配召回**。

**对 ripgreptool 的价值**：这是"搜索更准"的核心缺失能力。现在搜 `stack` 找不到
`HandlerStack`，搜 `func` 找不到 `my_func`，搜 `http` 找不到 `getHTTPResponse`。
落地方式：把 `rg` 的查询词从"原词"扩展为"原词 OR 各子 token"，或将拆分后的子 token
交给 rg 的 `-e` 多模式；在跳转定义场景，可对用户输入做同样的拆分来匹配 ctags 符号名。

**可行性**：高。纯文本正则，无新依赖，直接加到 `src/core`。

### 2. 定义提升（`ranking/boosting.py`）——比我们已做的更强

我们的 `ranking.ts` 已做"定义行优先"，但 semble 更进一步：

- 定义关键字表更全，且**区分大小写**（`_DEFINITION_KEYWORDS`：class/module/def/
  interface/struct/enum/trait/type/func/function/object/abstract class/data class/fn/
  fun/package/namespace/protocol/record/typedef），SQL 另用 IGNORECASE 单独一组
  （`CREATE TABLE/VIEW/PROCEDURE/FUNCTION`）。
- **定义提升是"按被查询符号"的**：不是"只要是定义行就加",而是正则匹配
  `<关键字> <被查询符号名>`（含命名空间前缀，如 `defmodule Phoenix.Router` 也能匹配
  `Router`）。`_chunk_defines_symbol()` + `_definition_pattern()`。
- 提升量：`max_score * 3.0`（乘法级，远强于我们的 0.2 加法）。
- 文件 stem 与被查符号吻合时再乘 1.5 档（`_definition_tier`）。

**对 ripgreptool 的价值**：把我们"定义行优先"升级为"**被查询符号的定义优先**"——
跳转定义时，真正定义 `foo` 的那个块/文件排最前，而不是所有含 `class/def` 的行都抬。

**可行性**：高。把 `isDefinitionLine` 升级为"行内容含 `<定义关键字> <符号名>`"即可，
符号名从跳转/搜索目标里取。

### 3. 路径噪声惩罚的精细版（`ranking/penalties.py`）

我们的 `computeFileRank` 已实现，semble 有几处更细、可直接补强：

- 测试文件正则按语言分组写得非常全（`_TEST_FILE_RE`），覆盖
  `test_foo.py`/`foo_test.go`/`FooTest.java`/`foo_spec.rb`/`foo.test.js`/`FooTests.swift`/
  `test_foo.cpp`/`FooSpec.scala`/`test_helpers.go` 等几十种。
- 还有 **re-export/元数据文件**惩罚：`__init__.py`、`package-info.java` 乘 0.5。
- **文件饱和衰减**（`_FILE_SATURATION_THRESHOLD=1`、`_FILE_SATURATION_DECAY=0.5`）：
  同一文件第 2 个及以后的命中块分数乘 0.5^n，**防止一个文件刷屏霸榜**。这是我们的排序
  还没有的维度——现在同文件多个匹配都平铺，会淹没别的文件。

**对 ripgreptool 的价值**：补测试文件名正则覆盖 + 加入"同文件多命中降权"（文件级饱和）。

**可行性**：高。

### 4. 多命中文件的一致性提升（`boost_multi_chunk_files`）

和饱和相反的另一面：如果**一个文件里多个块都高分命中**，说明该文件整体相关，给它的
最高分块再加 `max_score * 0.2 * (file_sum/max_file_sum)`。与饱和形成平衡——"该文件是
主题文件"时抬升，而不是盲目压。

**对 ripgreptool 的价值**：搜索结果里，命中行数多且质量高的文件应比只命中一行的文件更靠前。

**可行性**：高。我们已有每文件 `matches[]`，统计命中数/命中分数即可。

### 5. 查询类型自动判定（`is_symbol_query` / `resolve_alpha`）

`_SYMBOL_QUERY_RE` 区分"符号查询"（命名空间限定 `A::B`、下划线开头、含大写、含下划线）
和"自然语言查询"（纯小写普通词如 `session`）。符号查询更依赖精确 BM25，NL 查询更依赖
语义向量。

**对 ripgreptool 的价值**：跳转定义场景基本是"符号查询"（`foo`、`A::B`），可据此在
"精确符号匹配"和"模糊子串匹配"之间切换策略，避免把普通词误当符号精确匹配。

**可行性**：高，纯正则。

---

## 二、值得借鉴但需权衡/分阶段（新依赖或架构改动）

### 6. 标识符 token 化的 BM25 倒排索引（`index/bm25.py` + `enrich_for_bm25`）

- BM25 稀疏索引：倒排表按 term → 文档（chunk），查询时算 IDF×TF 分。
- **路径富化**（`enrich_for_bm25`）：把文件名 stem 重复 2 次 + 最近 3 层目录名拼进
  索引内容，让"按路径/文件名查"在 BM25 里天然命中。
- 支持增量更新：`add/remove_document`，mtime 未变则复用旧块。

**对 ripgreptool 的价值**：这是从"实时 rg 扫描"走向"预建索引"的核心。若做本地索引缓存，
能让多次跳转/搜索省掉每次远程扫描。但**需要引入索引文件与缓存管理**，且当前是远程
SSH 执行——更适合把 BM25 索引建在**远端**（ctags tags 已经很接近 BM25 的角色）。

**建议**：现阶段不要推翻现有架构。可先做轻量版——用已有 ctags `tags` 文件 + 文件名
富化，把"符号名查询"用精确 + 子 token 拆分跑 BM25 风格的打分，而不是直接上完整索引。

### 7. tree-sitter 语法分块（`chunking/core.py`）★ 对 C/C++ 很有价值

用 tree-sitter 解析语法树，块边界落在函数/类等**语义节点**上（递归合并/拆分节点直到
目标块长），而不是固定行数。这样每个检索单元是完整的函数/类，返回"精确代码片段"。

**对 ripgreptool 的价值**：跳转定义/搜索返回时，能给出"整个函数/类"而不是"单行命中"，
大幅提升可用性。ripgreptool 面向 C/C++，tree-sitter 的 c/cpp 语法可用。

**可行性**：中。需要引入 tree-sitter（WASM/native），或用**轻量替代**——用 ctags 的
`begin/end` 字段定位函数体边界（ctags tags 已含行号与结束行），在远端只读函数区间，
不必全量语法解析。这条对"跳转慢"反而是加分：只读函数体比读全文件省。

### 8. 缓存 + 增量重建 + 版本化元数据（`cache.py`）

- 索引按项目路径 sha256 缓存到用户缓存目录，跨平台（Win/macOS/Linux）。
- 元数据带 `CACHE_FORMAT_VERSION`、`chunk_size`、`model_path`、`time`；任一项不匹配
  （版本升级、分块参数变、模型变、文件 mtime 更新、文件集合变）即整索引失效重建。
- `get_file_status` 用 mtime + 文件集合比对判断是否 NEWER，实现**增量**：只重索引变更
  文件，其余复用。

**对 ripgreptool 的价值**：ripgreptool 已有 ctags tags 的缓存与指纹校验（git HEAD、
ctags 版本、schema、args），思路同源。可借鉴的增量点是"**按文件 mtime 只重建变更文件**
的 tags 片段"以及"缓存命中判定统一走版本元数据"，避免重复全量重建。

**可行性**：中。架构已部分具备，主要是把"全量重建"细化成"增量更新"。

### 9. 混合检索 + RRF 融合（`search.py`）

语义向量与 BM25 各自取 top-k×5 候选，各自转成 **RRF 分数** `1/(k+rank)`，再按
`alpha` 加权合并，最后做定义提升 + 路径惩罚 + 多文件一致性的重排。

**对 ripgreptool 的价值**：**RRF 融合**这个思想本身值得借鉴——即使没有向量索引，也可以
把"路径匹配分"和"内容命中分"两个异构分数用 RRF 融合，而不是直接相加（量纲不同时
加法没意义）。

**可行性**：中。RRF 融合逻辑可移植到 TS；但 dense embedding 需要 Python 模型
（model2vec + 下载 HF 模型），**公司离线/远程环境基本不现实**，且 ripgreptool 是纯 TS。
建议只取 RRF 与重排，不引入向量。

---

## 三、总结：给 ripgreptool 的落地优先级

| 优先级 | 借鉴点 | 改动 | 预期收益 |
|---|---|---|---|
| P0 | 标识符 camelCase/snake_case 拆分 | 新增 `src/core/identifiers.ts`，rg 查询扩展多模式 | 搜索/跳转"更准"，解决找不到 `HandlerStack`/`my_func` 类目标 |
| P0 | 定义提升按"被查询符号" | 升级 `isDefinitionLine` 为 `<关键字> <符号名>` | 跳转定义更精准 |
| P1 | 同文件多命中饱和降权 + 多命中文件一致性抬升 | 扩展 `ranking.ts` | 结果分布更均衡、更贴主题 |
| P1 | 查询类型判定（符号 vs 自然语言） | 扩展 `ranking.ts` | 精确/模糊策略自动切换 |
| P2 | 测试文件名正则补全 + re-export 惩罚 | 扩展 `ranking.ts` 正则 | 噪声识别更全 |
| P2 | RRF 融合（不引入向量） | 扩展排序 | 异构分数可比 |
| P3 | tree-sitter 语义分块 / 函数体区间读取 | 借助 ctags begin/end | 返回精确代码片段、跳转更快 |
| P3 | 按文件 mtime 增量重建 tags | 扩展 tags 缓存 | 减少重复全量重建 |

> 语义向量索引（dense embedding）与完整 BM25 预建索引，因公司离线/远程 + 纯 TS 架构，
> 现阶段不推荐引入；其"重排"与"融合"思想已足够有借鉴价值。
