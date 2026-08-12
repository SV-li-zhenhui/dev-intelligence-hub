# GitHub CLI 登录凭据代理设计

**日期：** 2026-08-12

**状态：** 已批准（2026-08-12，负责人批准推荐设计）

**适用范围：** MyDashboard GitHub Review、评论、更新分支、受控 push 与 merge 的外部动作执行和恢复

## 1. 背景

MyDashboard 已经能够让岗位生成 GitHub 动作提案，并把每个高风险动作持久化到统一确认队列。动作只有在负责人逐项确认后才会进入执行器；执行器还会重新核验账号、PR 输入、Git target、幂等标记和动作结果。

当前执行器只支持从 `githubActions.tokenEnv` 读取 Token。负责人已经通过官方 GitHub CLI 登录本机账号，但 MyDashboard 不能复用这个登录状态，因而页面即使生成了 Review 提案，也会在执行阶段因缺少环境变量 Token 而失败。

本设计增加推荐的 `gh-login` 凭据模式：受信任的短生命周期代理通过固定 GitHub CLI 获取指定账号的 Token，只在已确认动作的执行或恢复期间放入内存，并继续沿用现有确认、账号复核、目标核验、幂等和审计边界。

## 2. 目标

1. 让 MyDashboard 在不要求负责人手工复制 Token 的情况下复用同一服务用户已经完成的 `gh auth login`。
2. 保持 `token-env` 模式兼容；旧配置在升级后不得静默改变账号、凭据来源或计费边界。
3. Review 专用执行路径与通用 PR 动作路径必须使用同一凭据抽象和同一账号绑定规则。
4. 凭据只能在已确认动作执行或可信恢复期间获取；生成提案、浏览确认队列、拒绝提案和模型推理都不能读取凭据。
5. Token 不进入配置、页面、持久状态、审计、日志、模型上下文、命令参数或错误文本。
6. 登录缺失、账号不符、输出异常、超时、取消、可执行文件变化或进程树清理无法证明时必须失败关闭，且不得开始 GitHub 写入。
7. 服务重启后仍能对已开始动作做幂等核验，不能因为切换凭据模式而重复评论、Review、push 或 merge。

## 3. 非目标

- 不自动批准任何确认项，不降低逐项确认要求，也不提供“全部自动发布”开关。
- 不把 GitHub 权限交给岗位大脑、Codex、Claude、Ollama 或 OpenAI-compatible Provider。
- 不把宿主 GitHub CLI 配置目录挂载或复制给动作子进程。
- 不读取、解析或修改 `hosts.yml`、系统钥匙串或凭据管理器；这些细节只由官方 `gh` 处理。
- 不支持任意 hostname、GitHub Enterprise、自定义 `gh` 参数、脚本、shell 片段或仓库工作目录。
- 不新增 Token 缓存、Token 备份、跨机器同步或持久凭据镜像。
- 不改变现有动作白名单、受控 commit、Git target 或输入授权规则。

## 4. 方案选择

### 4.1 采用：短生命周期 `gh auth token` 代理

受信任代理使用固定可执行文件和固定参数：

```text
gh auth token --hostname github.com --user owner-login
```

`owner-login` 来自已确认的版本化配置 `actorAccountId`，必须先通过 GitHub login 格式校验，不能由岗位输出、确认 payload 或 URL 提供。代理对输出做严格、有界校验，然后把 Token 交给当前一次执行的受信任适配器。适配器用同一 Token 调用 GitHub `/user`，确认实际账号仍等于 `actorAccountId`，之后才允许继续目标核验和写入。

该方案复用官方 CLI 的登录和钥匙串能力，同时不让动作子进程接触宿主 profile，是安全性、可用性和实现复杂度之间的推荐平衡。

### 4.2 不采用：让动作子进程直接继承宿主 `gh` profile

这种方式不需要提取 Token，但会把整个 GitHub CLI 配置目录和潜在多账号状态暴露给执行动作的进程；账号选择、配置写回、登录切换和隔离也难以证明。它扩大了动作执行面的宿主权限，因此不采用。

### 4.3 保留兼容：环境变量 Token

现有 `tokenEnv` 行为继续作为 `token-env` 模式保留，适合服务账号或集中式密钥管理。它不是新建本地配置的推荐默认值，但不会被删除或自动迁移。

## 5. 配置契约

启用 GitHub 动作时，`githubActions` 增加显式 `credentialMode`：

```json
{
  "githubActions": {
    "enabled": true,
    "credentialMode": "gh-login",
    "actorAccountId": "owner-login",
    "ghCommand": "C:\\Program Files\\GitHub CLI\\gh.exe",
    "enabledActions": ["review"],
    "timeoutMs": 60000
  }
}
```

允许值和兼容规则：

- `gh-login`：推荐模式；禁止出现 `tokenEnv`。
- `token-env`：要求合法的 `tokenEnv`，行为与当前版本一致。
- 已持久化配置若没有 `credentialMode`，按 `token-env` 解释；不重写旧配置，也不因本机存在 `gh` 登录而静默切换。
- `githubActions.enabled=false` 时可以保留完整配置以便后续恢复，但不会构造可执行 GitHub 写入端口。
- `actorAccountId`、`ghCommand`、`enabledActions` 和现有网络环境规则不变；hostname 固定为 `github.com`，不能配置。
- `credentialMode` 是安全敏感且需要重启的路径，必须进入版本化配置预览、审计和确认。切换模式本身不增加动作种类；账号或动作白名单变化仍按现有授权扩张规则处理。
- `timeoutMs` 的统一合法范围为 1000–600000 ms；配置契约、confirmation runtime 和两条动作 transport 必须使用同一范围，不能出现“草稿可激活、重启后才拒绝”的分层差异。
- 配置永远不接受 Token 值、GitHub CLI profile 路径、命令参数或工作目录。

配置页面提供两个来源选项：

- `GitHub CLI 当前登录（推荐）`
- `环境变量 Token（兼容）`

选择 `gh-login` 时隐藏并从草稿中移除 `tokenEnv`；选择 `token-env` 时显示 Token 环境变量名。页面只说明“将在确认执行时检查指定账号登录”，不展示 Token，也不在普通页面轮询中获取 Token。

## 6. 架构与职责

### 6.1 `GitHubCredentialSource` 端口

两种模式实现同一个仅供执行器使用的异步端口：

```text
acquire({ actorAccountId, signal, deadline }) -> CredentialLease
CredentialLease.use(callback) -> result
CredentialLease.release() -> void
```

约束如下：

- 一个 lease 只服务一次确认动作的执行或一次恢复核验。
- `use` 的回调范围之外不能取得 Token；release 幂等并清除代理持有的引用。
- JavaScript 运行时不能保证物理擦除不可变字符串，因此实现只承诺最短生命周期、不持久化、不记录和不跨请求复用，不声称内存安全擦除。
- 端口不暴露到 HTTP、页面、岗位、工作流、记忆或模型路由。

`TokenEnvCredentialSource` 在 acquire 时读取固定环境变量名并执行现有格式校验。`GhLoginCredentialSource` 执行本设计的受监管 CLI 流程。应用组合根依据不可变的活动配置只构造其中一个来源。

### 6.2 `GhLoginCredentialSource`

该组件只负责四件事：

1. 校验调用者给出的账号等于活动配置绑定账号；
2. 重新核验固定 `gh` 可执行文件身份；
3. 用固定参数执行一次 `gh auth token`；
4. 严格解析 Token 并创建短生命周期 lease。

它不理解 PR、Review、确认 payload 或 GitHub API，也不能执行任何写操作。

### 6.3 GitHub 动作消费者

以下两条现有路径都改为异步获取 lease：

- `github.work-proposal-review` 使用的 Review 适配器；
- 评论、Review、更新分支、受控 push 和 merge 使用的通用 PR 动作执行器与 transport。

消费者仍负责：

- 核对 confirmation envelope、approval binding 和当前输入授权；
- 使用 Token 调用 `GET /user` 并校验账号；
- 核对 PR 当前 Git target 和幂等标记；
- 仅在所有最终检查通过后执行一个白名单动作；
- 验证响应并生成不含凭据的持久 receipt。

Review 专用路径与通用路径不能各自实现一套 `gh auth token` 逻辑。

### 6.4 确认边界

凭据来源只注入 confirmation executor/router 后方。以下操作调用次数必须为零：

- PR/Issue 观察和刷新；
- 岗位或 taskBrain 生成动作提案；
- 提案持久化和进入确认队列；
- 查看 next、history、详情或系统状态；
- 拒绝、失效或尚未批准的确认项；
- 配置校验、dry-run、预览和普通启动就绪检查。

只有两种路径可以调用 acquire：

1. 用户批准单个确认项后，该项从 pending 进入 executing；
2. 服务恢复一个已经处于 executing/unknown 的确认项，并只做幂等 reconcile。

恢复 pending 项不得调用凭据，也不得自动转为 executing。

## 7. 可执行文件与进程隔离

### 7.1 固定可执行文件

活动配置中的 `ghCommand` 必须是绝对路径。启动时解析并记录最终文件身份；每次 acquire 前重新验证：

- 是普通可执行文件，不是目录、符号链接、junction、reparse point 或多链接别名；
- 最终路径仍等于启动时固定路径；
- 文件大小、修改身份和 SHA-256 与已接受描述符一致；
- Windows 文件名为 `gh.exe`，其他支持平台为原生 `gh`；
- 文件变化、消失或身份无法证明时返回 CLI unavailable，不尝试 PATH fallback。

测试可以注入假描述符和假进程 runner；生产配置不能提供 wrapper、前置参数或 shell。

### 7.2 固定命令与工作目录

`GhLoginCredentialSource` 只允许以下参数序列：

```text
auth token --hostname github.com --user owner-login
```

命令通过 `shell=false` 启动，stdin 为空，cwd 是 MyDashboard 私有运行时内的一次性空目录，绝不能是项目、宿主仓库、Code Job workspace 或用户主目录。目录创建、最终身份校验和清理沿用受监管 CLI 的进程树与临时目录机制。

### 7.3 最小环境

凭据命令从空环境构造允许列表：

- 运行原生进程所需的 `SystemRoot`/`WINDIR`、临时目录和当前服务用户的默认 profile 定位字段；
- `GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`、`GH_PAGER=cat`、`NO_COLOR=1`；
- 不传递 `GH_TOKEN`、`GITHUB_TOKEN`、`GITHUB_*`、`GIT_*`、`SSH_*`、`NODE_OPTIONS`、代理配置、仓库路径或模型相关凭据；
- 不接受页面可配的 `GH_CONFIG_DIR`。第一版只使用运行 MyDashboard 的同一 OS 用户默认 GitHub CLI 登录位置。

Token 获取完成后，动作子进程仍使用现有更窄环境：`GH_TOKEN`、固定 host、非交互标志、必要系统变量和已确认的网络环境允许列表。动作子进程不继承 profile 定位字段，因此不能读取或修改宿主 GitHub CLI 配置。

## 8. 输出、超时、取消与清理

- `gh auth token` stdout 上限为 4096 bytes，stderr 上限为 8192 bytes；超限立即终止进程树。
- 只接受 UTF-8 的单个非空 Token 行和最多一个平台换行，且 stderr 必须为空；额外行、前后空白、控制字符、截断输出、stderr 内容或非零退出均无效。
- stderr 不论内容如何都不作为用户可见错误透传；错误只映射为稳定代码。
- Token 不能出现在命令参数、调试对象、异常 cause 的可序列化字段或测试快照。
- `githubActions.timeoutMs` 是一次 execute/reconcile 的总 deadline。凭据获取最多使用总剩余时间与 15 秒中的较小值；账号检查、目标读取、幂等检查和动作调用都只能使用剩余时间，不能让每个子进程各自重新获得完整 timeout。
- 用户取消、服务关闭或 deadline 到期时终止整个子进程树。只有确认进程树退出并完成临时目录清理后，才能把失败标记为“写入尚未开始”。
- 若进程树退出或清理无法证明，执行失败关闭并产生恢复 blocker；不能继续账号检查或 GitHub 写入，也不能自动重试。

## 9. 账号绑定与最终写入门禁

`--user` 只负责从本机已登录账号中选择配置账号，不被视为最终证明。每个消费者必须用获取到的 Token 调用固定 `github.com` 的 `GET /user`，并对 login 做大小写不敏感的精确比较。

写入前顺序为：

1. 当前 confirmation 和 input authority 仍有效；
2. acquire 当前配置账号的 credential lease；
3. `GET /user` 等于 `actorAccountId`；
4. 查找幂等标记；
5. 读取并精确比较 PR Git target；
6. 再次检查 input authority；
7. 在最终写入前再次确认账号和 target 未变化；
8. 执行且只执行确认 payload 中的一项白名单动作；
9. 校验返回值和幂等标记，持久化 receipt；
10. release lease。

任何账号不符都返回 `GITHUB_ACTOR_MISMATCH`，写入次数为零。Token scope 是否足够由 GitHub API 决定；MyDashboard 不扩大 scope，也不把权限不足自动解释为可重试写入。

## 10. 恢复与幂等语义

服务重启时：

- pending 项保持 pending，不获取凭据；
- executing/unknown 项可以 acquire 当前活动模式的凭据，只执行只读账号、marker、target 和 receipt 核验；
- 找到唯一匹配 marker 时记为 already/completed；
- 证明 marker 不存在且写入从未开始时可以回到明确失败，由负责人决定是否重试；
- 不能证明结果时保持 unknown，并阻止自动再次 POST；
- 登录不可用或账号不符时保留恢复证据，等待负责人修复登录或配置，不退回到环境变量，也不选择其他账号。

凭据模式从 `token-env` 切换到 `gh-login` 不改变 confirmation payload 中绑定的账号、目标和动作。恢复仍必须用当前活动配置验证同一个 `actorAccountId`；账号、目标、动作或输入授权变化继续按现有规则失效。模式切换本身经版本化配置逐项确认并在重启后生效。

## 11. 稳定错误与可观测性

新增或统一以下不含秘密的错误代码：

- `GITHUB_CLI_UNAVAILABLE`：固定 CLI 不存在、身份变化或不可验证；
- `GITHUB_LOGIN_UNAVAILABLE`：指定账号没有可用登录；
- `GITHUB_CREDENTIAL_TIMEOUT`：凭据阶段超过剩余 deadline；
- `GITHUB_CREDENTIAL_OUTPUT_INVALID`：输出格式、大小或编码无效；
- `GITHUB_CREDENTIAL_CLEANUP_FAILED`：进程树或临时目录清理无法证明；
- `GITHUB_ACTOR_MISMATCH`：Token 实际账号不等于配置账号。

页面可以显示错误代码对应的操作建议，但不能显示 `gh` 原始 stdout/stderr、配置文件路径、Token 前缀、摘要或长度。审计只记录模式、配置版本、确认 ID、动作类型、目标、账号、稳定结果和时间，不记录 credential lease 的内容。

## 12. 测试策略

### 12.1 配置与页面

- 旧配置缺少 `credentialMode` 时仍按 `token-env` 工作；
- `gh-login` 禁止 `tokenEnv`，`token-env` 必须有合法引用；
- 模式、账号、命令和动作白名单进入 impact/restart/audit；
- 页面条件字段、默认推荐项、切换模式和浏览器 round-trip 正确；
- 配置、API、HTML、日志和状态响应都不出现 Token。

### 12.2 凭据代理单元测试

使用假 `gh` 和可记录 runner 验证：

- 命令、参数、cwd 和环境完全等于允许集合；
- actor 不能注入参数；不存在 shell、PATH fallback 或仓库 cwd；
- 正常单行 Token 可用且不持久化；
- 缺少登录、非零退出、额外 stdout/stderr、错误编码、空白、超限和截断均失败关闭；
- timeout、取消、服务关闭和进程树清理失败产生稳定结果；
- 可执行文件被替换、链接或改写后不会启动；
- 宿主 `GH_TOKEN`、`GITHUB_TOKEN`、Git、SSH、模型及其他环境变量不会泄漏；
- 测试失败输出和快照不包含虚构 Token。

### 12.3 执行与恢复集成测试

对 Review 专用和通用 PR 动作两条路径分别证明：

- 提案生成、next/history/read、reject 和 pending recovery 的 broker 调用为零；
- approve 后才 acquire，随后依次发生 actor、marker、target、authority 和写入检查；
- 错误账号、旧 head、失效输入、缺少权限或凭据失败时写入为零；
- marker 已存在时 reconcile 完成且不重复写入；
- 写入结果不确定时重启恢复只读核验，不自动第二次写入；
- comment、review、update_branch、受控 push、merge 的现有白名单和受控 commit 约束保持不变；
- `token-env` 的现有测试全部继续通过。

### 12.4 最终验收

- 使用本地假 GitHub API/假 `gh` 完成可重复的写入和崩溃恢复测试；
- 使用真实登录的 GitHub CLI 时，只允许 MyDashboard 在负责人明确确认后的产品执行路径取用凭据；Codex 不直接运行 `gh` 代替系统验收；
- 在负责人未确认任何真实动作前，只能验证配置、CLI 身份和无写入证据，不能为了验收绕过确认门禁；
- 最终稳定 HEAD 纳入一次全量 Node、Docker、浏览器、恢复和开源分发验证。

## 13. 文档与交付

实现后同步：

- `config.example.json`：新建本地配置推荐 `gh-login`，保留 `token-env` 示例说明；
- `docs/OPERATIONS.md`：登录前提、配置步骤、失败恢复和逐项确认；
- `docs/PRIVACY.md`：Token 的内存生命周期、不会持久化以及无法承诺物理内存擦除；
- `docs/ARCHITECTURE.md`：credential source、confirmation executor 和两条 GitHub transport 的边界；
- 开源分发测试：不打包宿主 profile、Token、私有运行时或测试凭据。

## 14. 验收标准

本功能只有同时满足以下条件才算完成：

1. 页面能选择 `GitHub CLI 当前登录（推荐）`，版本化配置确认和重启后生效。
2. 没有 Token 环境变量时，已登录指定账号仍能在用户逐项确认后由系统执行动作。
3. 未确认、已拒绝、已失效或仅浏览的提案从不读取凭据、从不写 GitHub。
4. 错误账号、登录缺失、CLI 被替换、输出异常、超时或清理失败时写入次数严格为零。
5. 两条 GitHub 动作路径行为一致，环境变量模式无回归。
6. 重启恢复不会产生重复 Review、评论、push、更新分支或 merge。
7. Token 在配置、页面、状态、日志、持久状态、备份、验收产物和模型上下文中均不可见。
8. 所有 scoped 测试、独立安全/可靠性审查和最终一次全系统验收通过。
