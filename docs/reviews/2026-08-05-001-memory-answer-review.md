# 代码审阅：记忆智能 (U7) — 审阅与修复清单

- **日期**: 2026-08-05
- **审阅范围**: `feat/controlled-code-executor` 工作区 vs HEAD `2b5a8f7`（23 文件, ~3900 行新代码, 含 8 个未跟踪文件）
- **对应计划**: `docs/plans/2026-08-02-001-feat-complete-command-center-plan.md` U7 "Add cited memory intelligence"
- **审阅模式**: report-only（未改任何代码）
- **审阅者 (11)**: correctness, testing, maintainability, security, api-contract, reliability, performance, adversarial, project-standards, agent-native, learnings-researcher
- **结论**: **Ready with fixes** — 无 P0；2 个 P1 应在合并前处理

---

## 一、修复执行清单（按优先级）

> 每个发现均标注：文件:行、问题、修复方向、验证方式。修复者逐项执行并自测。

### P1 — 合并前必须处理

#### [#1] LocalSessionImporter 完全未接线（死代码）

- **位置**: `src/services/local-session-importer.js:429`
- **问题**: 类存在完整逻辑（461 行），但 grep 确认除自身文件外**零引用**：composition-root 未实例化、server 无导入路由、前端无 UI。计划 U7 文件清单明确包含此文件，测试场景要求"重复导入幂等"，但该能力对用户和 agent 都不可达。
- **证据**: 全仓库 `grep -rn "LocalSessionImporter\|local-session-importer" src/ public/` 仅命中文件自身；`src/server.js`、`src/composition-root.js` 无 `import-session`/`importSession` 路由或接线。
- **修复方向（三选一）**:
  1. **接入（推荐，满足计划 U7）**:
     - 在 `src/composition-root.js` 实例化 `LocalSessionImporter`（依赖 `memoryRuntime.producer` 的 `appendBatch` 端口），作为 frozen port 暴露。
     - 在 `src/server.js` 仿照 `/api/memory/answer` 加 `POST /api/memory/import-session`（`assertTrustedMutation` + `readJsonBody` 限流，建议 4MB+ 余量，因为会话最大 4MB）。
     - 按计划 R17"optional explicitly imported"加**显式 opt-in 配置标志**（fail-closed），如 `config.memory.importing.enabled`。
  2. 若本期不接线：在文件头加明确 `TODO` 注释，并在 composition-root 接线处附近注明延迟原因。
  3. 若放弃该能力：删除文件及测试。
- **验证**: 新增 server 集成测试（导入成功 / 重复导入幂等 / 超限 413 / 无效会话 400）；确认幂等（appendBatch 按内容寻址 recordId 去重）。

#### [#2] 远程 egress 安全边界依赖元数据启发式分类

- **位置**: `src/services/memory-context-retriever.js:322`（`dataClasses()`）
- **问题**: 当目标 brain 是远程 provider 时，`BrainRouter.generate` 以 `dataClasses` 为授权门（`remoteData[class] !== true` → 403）。但 `dataClasses()` **仅凭 source.kind/eventType/tags 的元数据正则分类，从不检查记录内容**。含代码片段的记录若被归为仅 `memory` 类，可被仅授权 memory 的远程 provider 收走。真实风险案例：work-contract（归为 requirements-only）的验收标准自由文本可能含代码片段，泄漏给仅授权 requirements 的 provider。
- **注意**: 当前默认配置 ollama `remote:false`，此门**不触发**；配置远程 provider 后成为现实。`AMBIGUOUS_SOURCE_KINDS` 是 over-classify（fail-closed），非此问题。
- **修复方向**:
  - 短期：在 `dataClasses()` 增加**内容感知的防御性 catch-all**——对 `summary`/`evidence` 内容做关键字扫描，**只能加类不能删类**（保守方向）。
  - 长期：在记录创建时由 projector 打**权威数据类标签**（domain 层决策），retriever 分类降为次级校验。
  - 同时修正 `#13` 的宽松正则（见下），避免 `ci` 匹配 "specification" 造成误分类。
- **验证**: 构造混合内容记录（requirements 类记录含代码片段），断言远程调用被 403 拒绝或类被补全。

### P2 — 建议处理

#### [#3] readRecords 每次调用重建全量 journal Map

- **位置**: `src/services/local-memory-journal.js:630`
- **问题**: `readRecords` 每次调用 `new Map(this.#journal.records.map(...))` 重建整个 journal（`DEFAULT_MAX_RECORDS=20000`），每次 `/api/memory/answer` 触发。验证者另发现 `#append`（:687）也重建同一 Map。
- **修复方向**: 维护持久 `#recordsById`（在 `recover()`/`#append()` 更新），与现有 `#index` token-map 模式一致。
- **验证**: 单元测试确认 readRecords 不再每调用重建 Map（可加性能断言或用 spy）；20000 记录规模 smoke test。

#### [#4] recordLabels 每记录扫描全量 journal

- **位置**: `src/services/local-memory-journal.js:450`
- **问题**: `recordLabels` 对每个请求记录（≤20）做 `records.some(evidence.includes("supersedes:..."))` 扫描全量 journal → O(k×N×E)，最坏 ~8M 字符串比较。
- **修复方向**: 在 `readRecords` 内**一次 O(N)** 构建 superseded-by Set，或维护持久索引（在 append/recover 更新）。
- **验证**: 单测断言 20 记录请求在 20000 记录 journal 上的行为正确；复杂度改进可基准验证。

#### [#5] JSON Schema 与手写校验器边界漂移风险

- **位置**: `src/domain/memory-answer-contract.js:13`
- **问题**: `MEMORY_ANSWER_JSON_SCHEMA`（发给 LLM）与手写校验器（`parseStructuredMemoryAnswer`/`claim`）各自硬编码同一组边界（claims≤12、citationIds≤8、statement≤4096、64KB 输入），两处漂移会让 LLM 产出后端拒绝的响应，或反向放宽。
- **修复方向**: 提取具名常量（`MAX_CLAIMS=12`, `MAX_CITATIONS_PER_CLAIM=8`, `MAX_STATEMENT_BYTES=4096`, `MAX_RESPONSE_BYTES=64*1024` 等），JSON Schema 与手写校验器双处引用。
- **验证**: 加漂移检测测试（断言 JSON Schema 的 bounds 与校验器行为一致）。

#### [#6] provider `remote` 标志被静默覆盖

- **位置**: `src/services/configured-workforce.js:76`
- **问题**: `providerWithBoundary` 返回 `remote: provider.remote || remote`。若 provider 内建 remote 而 config `remote:false`，config 被静默忽略——违反配置即权威的直觉，也可能弱化 fail-closed。
- **修复方向**: 决策配置语义：若 config 权威 → `remote: config.remote ?? provider.remote`；若 config 声明额外远程 → `remote:false` 于内建远程 provider 应抛配置错误而非静默忽略。
- **验证**: 单测覆盖 provider 内建 remote × config remote true/false/undefined 四种组合。

#### [#7] /api/memory/answer 无并发控制

- **位置**: `src/server.js:1579`
- **问题**: 单进程服务器，多个并发 answer 各触发一次 Ollama/远程 generate，可能耗尽本地推理资源或堆积请求。
- **修复方向**: 简单在途计数（1-2 并发上限），饱和时返回 429/503 "busy"。单用户本地工具此方案足够。
- **验证**: 并发请求测试断言饱和时被拒绝而非全部执行。

### P3 — 视方便处理

| # | 位置 | 问题 | 修复方向 |
|---|------|------|---------|
| 8 | `memory-answer-service.js:312` | beforeGenerate/generate 错误绕过重试与错误契约（HTTP 层安全网存在；provider 错误原样通过是刻意设计） | 显式区分验证失败重试与 provider 瞬态错误；保留原样通过则加注释 |
| 9 | `local-session-importer.js:447` | 批量导入部分失败无进度提示（appendBatch 幂等可重试，无数据损坏） | 错误对象附 `added` 计数 |
| 10 | `memory-answer-service.js:223` | 响应 context 含 10+ 未用 packet 字段（dataClasses/citableRecordIds/totalMatched/truncated/indexHealthy/retrievalVersion/promptVersion/journalRevision/retrievalKind） | 瘦身为 `{contextDigest, recordIds, question, records}`（records 前端展示需要，保留） |
| 11 | `memory-answer-service.js:230` | `localRerunAvailable: true` 硬编码 | 从构造器/配置派生 |
| 12 | `memory-answer-service.js:345` | 重试循环后死代码 throw（不可达） | 删除或改 while 循环 |
| 13 | `memory-context-retriever.js:329` | 宽松正则过度分类（`ci` 匹配 "specification"） | 加词边界锚定或 token 全匹配 |
| 14 | `memory-answer-service.js:334` | validateClaims catch 捕获所有错误类型，程序性 bug 被当坏输出重试 | 只重试预期错误（MemoryAnswerContractError / MEMORY_ANSWER_CITATION_INVALID），其余重抛 |
| 15 | `memory-answer-service.js:210` | 顶层 `citations` 字段前端未用（前端用 context.records） | 移除或文档化 canonical 路径 |
| 16 | `memory-answer-service.js:219` | `answer: "证据不足"` 硬编码在服务层 | 返回 null，展示层本地化 |
| 17 | `memory-context-retriever.js:278` | `"lexical-v1"`/`"cited-memory-v1"` 重复 3 处 | 提取模块常量 |
| 18 | `local-session-importer.js:212` | 分块管线过度设计（fragmentFits+splitEntryContent+transcriptFragments+chunkTranscript+PROBE_INDEX 哨兵） | 折叠为单遍贪婪按字节分块 |
| 19 | `memory-context-retriever.js:322` | dataClasses 分类逻辑内嵌 retriever | 提取到 `src/domain/memory-data-classes.js` |
| 20 | `memory-answer-service.js:151` | 远程 brain 收到未过滤完整记录内容（与 #2 同源，已并入 #2） | 见 #2 |

---

## 二、测试缺口（需补测试）

> 来自 testing reviewer。P1 缺口应在合并前补，其余随功能推进。

### P1 测试缺口

| 位置 | 缺口 | 补测内容 |
|------|------|---------|
| `memory-answer-service.js:168` | validateClaims citable-子集分支未测 | packet 含 2 记录但 citableRecordIds 仅 1，模型引非 citable → 断言 MEMORY_ANSWER_CITATION_INVALID（走 citable-set 检查而非 accessible-set 检查） |
| `memory-context-retriever.js:307` | MEMORY_CONTEXT_TOO_LARGE 单记录路径未测 | 单记录超 maximumContextBytes → 断言 413 |
| `memory-context-retriever.js:417` | MEMORY_CONTEXT_BINDING_INVALID context-kind 未测 | context-kind 超记录数上限 / 记录超字节预算 → 断言 409 |

### 其余测试缺口（P2/P3）

- `splitEntryContent` 413 基线（`local-session-importer.js:253`）
- contract `from>to` 时间范围（`memory-answer-contract.js:162`）
- `parseStructuredMemoryAnswer` 64KB cap（`memory-answer-contract.js:246`）
- server `/api/memory/answer` 400/413 错误路径（`server.js:1586`）
- `answer()` mode:local 路由（`memory-answer-service.js:298`）
- beforeGenerate 完整 payload（`test/memory-answer-service.test.js:186`）
- 前端 cited-answer 契约（`test/frontend-memory-contract.test.js` — app.js 365 行新代码未覆盖）
- 模型对抗性响应模糊测试（嵌套 JSON/Unicode 转义）
- 并发导入幂等性

---

## 三、Agent-Native 差距

- **Critical**: 记忆问答仅 UI/API 可用，`memoryAnswer` 未传入 workforce/role context（`composition-root.js` 仅放返回对象）。员工角色无法发起带引证的记忆提问。建议至少把 `answer`/`retrieve` 作为 primitive 暴露给 orchestrator 角色。
- **Critical**: LocalSessionImporter 对用户和 agent 均不可达（并入 #1）。
- **Warning**: 角色上下文把 `memory` 列为 data class 但从不填充记忆内容或提供查询能力，类名存在而能力缺失。
- **Observation**: `localRerunAvailable` 硬编码（并入 #11）。

---

## 四、残余风险（记录在案，非阻塞）

- 无并发/限流（#7）；Ollama keep_alive 30m 占 VRAM；内存 journal 无驱逐（容量满硬失败）；单进程无并发边界。
- prompt injection 无法完全消除（系统提示 + 结构校验 + 引文验证分层防御，限制爆炸半径为"误引真实记录"，非任意数据外泄）。
- 错误码差异理论上可辅助记录 ID 枚举（loopback-only 内不可利用）。

---

## 五、审阅过程说明

- 11 个审阅 agent 并行审阅；关键发现经 6 个独立验证 agent 二次核查。
- **重大裁决**: adversarial 原 P1"远程数据外泄"降为 P2——`BrainRouter.generate` 在 provider.remote=true 时实际强制远程授权门（403），安全风险不在"授权缺失"而在"分类准确性"（#2）。
- **降级**: context 记录泄漏（原 P2→P3，前端确实用 `context.records`）、beforeGenerate 错误（P2→P3，HTTP 安全网 + 刻意设计）、会话导入部分失败（P2→P3，幂等可重试）、性能两项（P1→P2，单用户本地最坏 <10ms）。
- **升级**: LocalSessionImporter 未接线（P2→P1，三方独立确认 + 计划 U7 承诺能力缺失）。

---

## 六、修复复核结果（2026-08-05）

本节记录实现后的处置结果；上文保留最初的 report-only 审阅原文，便于追溯。U7 当前无未解决的 P0/P1/P2。

| 发现 | 处置 | 结果与证据 |
|---|---|---|
| #1 会话导入未接线 | 已修复 | 增加 `memory.imports.localSessions` 显式开关、least-authority composition port 和受同源 JSON 写保护的 `/api/memory/import/session`；父级 `memory.enabled=false` 时不会实例化。Git 导入以相同边界接入。composition/server/config/importer 测试覆盖关闭、成功、幂等、无效与超限。 |
| #2/#13/#20 远程数据分类 | 已修复（保守策略） | 自由文本问题或任意检索记录统一标记 `requirements`、`code`、`memory` 三类；远程 brain 必须逐类得到授权，取消可能漏报的启发式正则。路由测试证明拒绝发生在 provider 调用前。 |
| #3 记录 ID 查询重建 Map | 已修复 | journal 在恢复和追加后维护 `#recordsById`。 |
| #4 superseded 全量扫描 | 已修复 | journal 在恢复时建立集合，成功追加后仅合并新记录的 supersession；读取不再逐记录扫描全 journal。 |
| #5 Schema/校验边界漂移 | 已修复 | claims、citations、statement 和 response 上限由同一组具名常量驱动；边界测试覆盖 64 KiB 与数组上限。 |
| #6 remote 被静默降级 | 已修复 | 实际远程 provider 不能被配置为本地；显式 `remote:true` 仍可把 loopback gateway 提升为远程边界。组合测试覆盖两种方向。 |
| #7 无问答并发控制 | 已修复 | 服务默认最多 1 个在途问题，饱和返回 429；取消会立即释放槽位。 |
| #8/#14 错误与重试边界 | 已修复 | 只对结构契约或 citation 校验失败进行一次纠正重试；provider/程序错误原样失败。 |
| #9 导入部分失败 | 已修复 | 单个会话先完整预检，再以一个最多 160 条的原子 appendBatch 写入；容量或格式失败时零写入。 |
| #10 context 字段较多 | 保留 | 这些字段用于上下文复现、截断/索引健康诊断和本地重跑，删除会削弱可审计性，并非死数据。 |
| #11 `localRerunAvailable` | 已解释 | MemoryAnswerService 构造时强制存在且验证一个非远程 local brain，因此该字段是服务不变量；若本地 brain 不成立，服务不会启动。 |
| #12 循环后的 throw | 原发现不成立 | 两次模型响应都未通过本地校验时该分支可达，负责返回稳定的 502，而非死代码。 |
| #15 顶层 citations | 保留 | 这是回答的最小引用投影；`context.records` 是可复现证据包。两者用途不同，前者避免 API 消费者自行处理完整记录。 |
| #16 “证据不足”文本 | 保留 | 当前 API/UI 中文契约依赖该稳定值；国际化不属于 U7，状态机仍以 `status` 为权威。 |
| #17 版本字符串重复 | 已修复 | 抽取 retrieval/prompt version 模块常量。 |
| #18 分块管线复杂 | 保留并加固 | Unicode 无损切分、完整条目重建、确定性 content ID 与最终记录双重字节边界都依赖该管线；折叠会增加边界风险。 |
| #19 分类模块位置 | 延后 | 当前保守分类只有一个调用者且无策略分支；在配置中心或新增权威字段时再提取，避免制造浅模块。 |

### 修复期间新增并解决的独立发现

- 父级记忆总开关现在同时禁止检索、问答与所有导入子能力，子开关不会绕过父开关。
- 112 KiB 检索预算通过真实 `retriever → answer service → router → Ollama adapter` 集成测试，证明 provider 单条 user message 不超过 128 KiB，且只按完整记录截断。
- 会话导入支持超过 100、最多 160 条的单次原子 journal 批量写入；161 条或容量超限均在写前失败。
- 会话切片同时按 32 KiB content 和 64 KiB 最终 MemoryRecord 判断；大量 `"` 或 `\\` 的 JSON 转义膨胀不再导致预检失败。
- 前端提问会先同步当前草稿筛选条件，避免答案上下文与屏幕列表来源不一致；旧请求会取消，不能覆盖新结果。
- 每条 citation 必须同时属于可访问记录和 `current raw` 可引用集合，派生或过时记录不能支撑回答。
- HTTP 客户端断开会一路取消到 provider fetch，并立即释放并发槽；用户取消记为 499，模型超时仍为 504，不产生伪 5xx 报警。
- 两种 structured provider 共用取消/超时生命周期；两种 importer 共用 hardened data/array/receipt 边界；上下文摘要复用统一稳定 digest。

### 明确延后但不能遗漏的最终目标

员工/岗位主动调用带引用记忆问答的 agent-native primitive 不作为 U7 UI/API 验收阻塞项，但必须在 U9 的持续 PR 工程协作及 U12 的 UI/API/employee action-parity 验收中完成。最终系统验收前，岗位只能被动获得 memory 类声明、却不能主动检索和追问的状态不允许保留。
