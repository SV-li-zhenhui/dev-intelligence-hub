# Codex 登录凭据代理设计

- 日期：2026-08-11
- 状态：推荐架构与书面规格均已获负责人批准
- 范围：Codex CLI 登录态大脑第一版
- 不包含：Claude CLI 登录态、GitHub 写操作、持久 CLI 会话、发布或推送

## 1. 背景与问题

MyDashboard 已经支持 `codex-cli` 与 `claude-cli` 作为主控、普通员工
`brain`、高能力 `taskBrain`、记忆问答和 Code Job 决策的大脑。每个已准入任务只启动
一次受监管 CLI；CLI 没有工具、动作端口、宿主仓库或 GitHub 凭据，输出仍由
MyDashboard 的领域契约和确认边界校验。

当前实现仍只接受固定环境变量凭据：Codex 读取 `OPENAI_API_KEY`，Claude 读取
`ANTHROPIC_API_KEY`。同时，每次调用都会获得新的空白 HOME、USERPROFILE、XDG
目录，因此当前 Windows 用户已经存在的 Codex ChatGPT 登录不会进入子进程。

本机已验证的事实是：

- Codex CLI 版本为 0.147.0；
- `codex login status` 返回 `Logged in using ChatGPT`；
- 默认文件登录缓存 `~/.codex/auth.json` 存在，是普通文件，并归当前 Windows
  用户所有；
- MyDashboard 服务与该登录缓存由同一个 Windows 用户运行；
- 现有 `codex exec` 已固定使用 `--ephemeral`、`--ignore-user-config`、
  `--ignore-rules`、只读 sandbox，并关闭 shell、apps、browser、computer、
  image、multi-agent 与 hooks。

Codex 官方文档说明：`CODEX_HOME` 同时承载认证、配置、日志、会话、技能和包状态；
`codex exec` 默认复用保存的 CLI 认证；ChatGPT 登录令牌会在使用期间自动刷新；
文件式凭据位于 `CODEX_HOME/auth.json`，必须按密码保护。由此可知，既不能把整个
宿主 `CODEX_HOME` 暴露给任务，也不能简单复制一次凭据后丢弃刷新结果。

参考：

- <https://learn.chatgpt.com/docs/auth>
- <https://learn.chatgpt.com/docs/config-file/environment-variables>
- <https://learn.chatgpt.com/docs/non-interactive-mode>

## 2. 目标

第一版必须做到：

1. 负责人可在配置页面明确选择 Codex CLI 使用现有 ChatGPT 登录态。
2. 当前服务用户已有文件式 Codex 登录时，不要求再次登录或在页面粘贴任何凭据。
3. 任务只获得完成该次模型调用所需的认证材料，不继承宿主 Codex 配置、规则、
   插件、MCP、技能、记忆、日志或会话。
4. Codex 刷新后的凭据可跨任务和 MyDashboard 重启继续使用。
5. 宿主执行 `codex login`、切换账号或 `codex logout` 后，下一次任务自动采用新状态。
6. 同一登录身份不存在并发刷新覆盖、旧凭据回写或任务间会话共享。
7. API-key 模式保持向后兼容；旧配置不会被静默切换到 ChatGPT 账号或不同计费路径。
8. 凭据内容、账号标识、文件路径和摘要不出现在配置、页面、日志、错误、审计、
   备份、测试产物或开源分发中。
9. 所有仓库、GitHub、代码执行和外部动作权限继续由 MyDashboard 掌握；认证方式
   不增加任何动作权限。

## 3. 非目标

第一版不实现：

- Claude CLI 的登录 profile 代理；Claude 继续使用现有 API-key 模式；
- 多个 Codex ChatGPT 账号或按员工选择账号；
- OS keyring 中凭据的导出或复制；只支持安全可验证的文件式 `auth.json`；
- 长期 Codex 会话、`resume`、跨任务上下文或 Codex 自身记忆；
- 把 MyDashboard 仓库、受控 Code Job 工作区或任意源仓库作为 CLI cwd；
- 把 `gh`、Git、SSH、GitHub token、MCP 或 shell 提供给 CLI 大脑；
- 在配置页面录入 token、选择凭据路径或执行任意登录命令；
- 自动评论、Review、更新分支、push、merge 或应用源仓库改动；
- 将凭据纳入备份、恢复或开源安装包。

OS keyring、Claude 登录代理、多账号池和并行登录身份可作为后续独立设计，不能在
本实现中以隐式兼容路径进入。

## 4. 方案比较

### 4.1 直接挂载宿主 `CODEX_HOME`

优点是实现最少，并且 Codex 可直接刷新宿主登录缓存。

拒绝原因：`CODEX_HOME` 不只有认证，还包含配置、插件、MCP、技能、会话、日志与
其他状态。即使命令行继续使用 ignore/disable 参数，这种方案仍扩大了受信输入面，
也破坏“每个任务空白 profile”的现有安全证明。

### 4.2 每次任务只复制 `auth.json`，任务后删除

优点是任务隔离强，不保留额外长期凭据副本。

拒绝原因：ChatGPT 令牌可能在调用中刷新。若刷新结果随临时目录删除，下一任务会
再次从旧宿主文件启动；刷新令牌轮换时可能直接失效。把结果写回宿主文件又会修改
用户的 Codex 状态，并引入与交互式 Codex 的竞争。

### 4.3 单独服务账号重新登录

优点是身份和生命周期最清楚，适合以后作为企业部署模式。

拒绝作为当前默认：它要求额外登录、单独账号运维和人工轮换，不能满足当前同用户
本地部署“不需要再点登录”的目标。

### 4.4 选定方案：凭据代理

采用三级边界：

```text
当前用户文件式登录源
  ~/.codex/auth.json
           |
           | 任务边界检测；只读取认证文件
           v
MyDashboard 私有持久凭据镜像
  不在仓库、数据目录或备份目录
           |
           | 每个任务复制；同一身份串行
           v
一次性 CODEX_HOME
  auth.json + 本次 Codex 自建临时状态
           |
           | 进程关闭后回收刷新结果
           v
原子替换私有镜像，然后删除整个任务目录
```

宿主登录源只负责表达负责人当前选择的账号与登录/退出状态；私有镜像负责让 Codex
刷新后的认证跨任务、跨服务重启保持连续；一次性 profile 继续承担任务隔离。

## 5. 配置契约

### 5.1 新字段

CLI provider 增加显式字段：

```json
{
  "kind": "codex-cli",
  "credentialMode": "codex-login",
  "remote": true,
  "timeoutMs": 300000,
  "maxResponseBytes": 131072,
  "maxRequestBytes": 262144
}
```

允许值：

- `api-key`：维持当前固定 `OPENAI_API_KEY` 行为；
- `codex-login`：使用本设计的文件式登录凭据代理。

兼容规则：

- 已持久化的 CLI provider 若没有 `credentialMode`，其有效值仍是 `api-key`；
- 不做静默迁移，不因本机存在登录缓存而自动改变账号或计费方式；
- 新建 Codex CLI provider 的页面模板默认写入 `codex-login`；
- Claude CLI 第一版只允许 `api-key`；为 Claude 选择 `codex-login` 必须精确失败；
- CLI provider 仍禁止 `baseUrl`、`apiKeyEnv`、`protocol`、`responseFormat`、
  `contextTokens`、可执行文件、参数和路径字段。

### 5.2 变更授权

`credentialMode` 属于 provider 身份与数据出口变化：

- 必须通过配置草稿、校验、影响预览和现有逐项确认队列激活；
- 影响预览明确显示“将使用当前服务用户的 Codex 登录身份并产生远程模型调用”；
- 激活后标记需要受管重启；
- 页面或启动过程不得因“检测到登录”而绕过配置确认；
- provider 的远程数据分类以及岗位 `brain`/`taskBrain` 绑定仍分别确认。

## 6. 可信边界与组件职责

新增一个生产内部组件，暂称 `CodexLoginCredentialBroker`。它只能由 composition root
发放不可伪造的生产能力构造，不能从公共配置注入文件系统、路径、命令、runner 或
凭据来源。测试替身必须通过名称明确的 test factory 注入，生产组合不得导入该入口。

职责分为四部分：

1. 定位并验证宿主文件式登录源；
2. 管理 MyDashboard 私有持久镜像；
3. 为一次调用租用一次性认证 profile；
4. 在进程关闭后验证并持久化 Codex 的刷新结果。

它不解析 token，不判断套餐，不查询账号资料，不调用模型，也不拥有任何 Git、GitHub
或代码执行端口。

## 7. 宿主登录源

### 7.1 路径来源

宿主 Codex 根目录只来自服务启动环境：

- 若存在 `CODEX_HOME`，要求它是已存在的绝对目录；
- 否则使用当前服务用户的 `~/.codex`；
- 认证文件固定为该目录直接子项 `auth.json`；
- 页面、配置文件和请求均不能提供或覆盖该路径。

### 7.2 文件准入

每次需要同步时，通过文件句柄读取并在读取前后验证：

- 是普通文件，不是 symlink、junction、reparse point、目录或设备；
- 路径没有链接祖先，文件身份在读取期间不变；
- 硬链接计数为 1；
- 文件所有者是当前 Windows 服务用户；
- 未授权主体没有写入、删除、改 owner 或改 ACL 的权限；
- 大小在 `1..65536` 字节内；
- 读取完整且未发生短读、追加或替换。

宿主文件允许继承当前用户 profile 的只读 ACL；代理不会要求改写用户的 `.codex`
权限。镜像目录自身则必须使用 MyDashboard 已有的私有目录管理器，建立受保护 ACL，
只允许当前用户、SYSTEM 和 Administrators 完全控制。

认证内容作为不透明字节处理。允许做内部 SHA-256 比较，但摘要不得进入页面、日志、
错误或审计。

## 8. 私有持久镜像

### 8.1 存储位置

镜像使用固定代码定义的位置，例如当前用户目录下的
`.mydashboard-cli-credentials-v1/codex-login`。它必须：

- 位于项目、应用数据、运维数据、备份和受控代码工作区之外；
- 通过私有目录管理器创建并在每次使用前重新验证身份与 ACL；
- 被加入 CLI 临时根、项目、数据、备份和代码工作区的相互隔离检查；
- 永远不被备份、恢复、导出、打包或开源扫描当作项目输入。

### 8.2 单文件原子状态

镜像以一个最大 `192 KiB` 的原子 envelope 保存：

```json
{
  "schemaVersion": 1,
  "sourceDigest": "<internal-only sha256>",
  "credentialDigest": "<internal-only sha256>",
  "credentialBase64": "<opaque auth.json bytes>",
  "updatedAt": "<timestamp>"
}
```

三个大小边界彼此独立：`MAXIMUM_CREDENTIAL_BYTES = 65536` 约束宿主 `auth.json`
以及暂存或捕获的实际凭据语义；`MAXIMUM_PRIVATE_FILE_BYTES = 192 * 1024` 约束
Task 2 通用私有文件（包括镜像 envelope）；`MAXIMUM_PACKET_BYTES = 384 * 1024`
约束承载 Base64 和固定协议元数据的 helper JSON 请求与响应封包。helper 的 stderr
仍限于 `4096` 字节并丢弃其文本。Task 3 在应用 `192 KiB` envelope 上限的同时，
必须独立拒绝解码后为空或超过 `65536` 字节的实际凭据。

envelope 只存在于私有目录。更新流程是：在同一已验证目录中新建唯一临时文件、完整
写入并同步、重新验证目录与文件身份，再以原子替换发布。崩溃前保留旧完整版本，
崩溃后清理有明确 owner marker 的临时文件；不存在历史归档。

读取时必须验证 exact keys、版本、字段类型、Base64、两个摘要、大小和普通文件身份。
任何歧义、损坏、链接或不完整写入均失败关闭，不能猜测或回退到旧临时文件。

### 8.3 来源优先级

在每个任务边界持有凭据租约后：

1. 安全读取宿主源并计算摘要；
2. 若宿主源不存在，视为已退出登录，删除或隔离销毁镜像并拒绝启动；
3. 若宿主源暂时不可安全读取，保留镜像但不得使用，等待下一次重新检测；
4. 若源摘要与 envelope 的 `sourceDigest` 不同，以宿主源创建新镜像；
5. 若源摘要相同，使用镜像中的刷新后凭据；
6. 若没有镜像，以当前宿主源初始化镜像。

这样，Codex 在镜像中刷新 token 不会因宿主源未变化而被旧源覆盖；负责人重新登录或
切换账号后，宿主摘要变化又会在下一任务覆盖镜像。

删除只能做到文件系统层面的最佳努力，不声称在 SSD 上实现物理安全擦除。

## 9. 单任务执行流程

`credentialMode=codex-login` 的一次 `generate` 流程如下：

1. 完成现有请求、schema、远程数据分类、取消和大小准入；未授权数据在读取凭据前
   失败。
2. 在同一个请求 deadline 内获取全局 Codex 登录凭据租约。
3. 同步并验证宿主登录源和私有镜像。
4. 创建现有受保护的一次性 invocation 目录。
5. 在 invocation 内创建专用 `codex-home`，只写入镜像中的 `auth.json`。
6. 构造空起点子进程环境：
   - `CODEX_HOME=<invocation>/codex-home`；
   - HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG、TEMP 全部仍指向本次目录；
   - 不包含 `OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEX_ACCESS_TOKEN`；
   - 不包含任何 `GH_*`、`GITHUB_*`、`GIT_*`、`SSH_*`、`NODE_OPTIONS` 或宿主
     profile 路径。
7. 使用已验证的固定 Codex 原生二进制和现有 no-tools/read-only 参数启动一次
   `codex exec`；cwd 仍是 invocation 目录。
8. 等待整个进程树关闭并读取、校验结构化结果。
9. 通过最终路径和句柄重新验证 invocation 中的 `auth.json`。若它安全且有变化，
   以相同 `sourceDigest` 原子发布新 envelope。
10. 删除 invocation 目录，释放凭据租约，然后返回结果或稳定错误。

凭据发布失败意味着任务最终状态不可完整证明，即使模型已返回结果也必须失败关闭，
不得返回一个看似成功的决策。进程树未被确认关闭时，绝不能读取或发布其凭据文件。

## 10. 并发、取消与关闭

所有 `codex-login` provider 共享同一服务用户身份，因此第一版使用一个进程内 FIFO
独占租约，覆盖：来源同步、整个模型调用、刷新结果发布和 invocation 清理。

- 同一登录身份最多有一个进行中的 Codex 模型调用；
- 等待租约的时间计入原请求 deadline；
- 等待期间取消或超时必须移除 waiter，且不得创建目录、读取凭据或启动进程；
- provider/application `close()` 先停止新准入，再取消等待者，等待当前调用完成其
  有界 reap、发布和清理；
- API-key Codex、Claude、Ollama 和 OpenAI-compatible provider 不共享此锁；
- 不允许按 provider id 建多个锁绕过同一身份串行要求。

串行会降低同账号并发吞吐，但避免两个 Codex 进程用同一刷新令牌并发刷新、后完成的
旧结果覆盖新结果。未来如需并行，应使用多个明确独立的服务身份，而不是放松该锁。

## 11. 登录变化语义

- 任务开始后，凭据快照保持不变；宿主登录文件变化不会中途切换该任务账号。
- 下一任务在租约内重新检测宿主源；重新登录或账号切换后自动采用新源。
- `codex logout` 导致源文件不存在时，下一任务先撤销本地镜像可用性，再以
  `STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE` 失败且不启动模型。
- 临时 IO/ACL 错误不会偷偷使用旧镜像；状态恢复后下一任务自动重试检测。
- 服务重启读取同一私有 envelope，因此正常 token 刷新结果不会丢失。
- MyDashboard 不修改宿主 `auth.json`，所以不会与用户的交互式 Codex 互相覆盖。

## 12. 错误与可观测性

对外只暴露稳定、本地化且不含秘密的状态：

- `available`：受支持 CLI 与文件式登录均可用；
- `file_login_unavailable`：没有可安全代理的宿主文件式登录源；这可能表示未登录，
  也可能表示当前登录只保存在第一版不支持的 OS keyring；
- `unsafe_source`：源身份、owner、ACL、链接或大小不满足要求；
- `broker_blocked`：私有镜像完整性、发布或清理失败；
- `cli_unavailable`：固定版本原生 CLI 不可用。

provider 继续映射到已有稳定错误族，例如
`STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE`、`STRUCTURED_PROVIDER_UNAVAILABLE`、
`STRUCTURED_PROVIDER_TIMEOUT`、`STRUCTURED_PROVIDER_CANCELLED` 与
`STRUCTURED_PROVIDER_CLEANUP_FAILED`。错误不得包含：

- token、认证 JSON、Base64、摘要；
- 账号、邮箱、workspace id 或套餐；
- 宿主/镜像/临时绝对路径；
- Codex stdout/stderr 原文；
- 请求 prompt、PR 内容或仓库数据。

内部审计只记录 provider id、credential mode、状态代码、时间和是否发生安全的来源
代际切换，不记录来源摘要或凭据变化内容。

## 13. 页面与运维体验

配置页面的 Codex CLI card 增加“认证方式”选择：

- `Codex 当前登录（受管代理，推荐）`；
- `环境变量 API Key`。

页面显示独立的只读预检结果：

- CLI 是否已安装且版本受支持；
- 当前服务用户的文件式 Codex 登录是否可代理；
- 当前活动配置是否需要重启；
- 若不可用，显示固定修复指引，例如“请在运行 MyDashboard 的同一 Windows 用户下
  执行 codex login”。

页面绝不显示账号、token、路径、文件时间或摘要，也没有上传/下载/查看凭据按钮。

只有在文件式源已经安全复制进隔离 profile 后，预检才使用固定
`codex login status` 形状，通过 KnownCliLocator 与 SupervisedProcessRunner 运行；
它绝不以完整宿主 `CODEX_HOME` 为 profile。预检参数固定、无 shell、无模型调用、
短 deadline、小输出上限，并与任务使用同一凭据租约，结果只投影上述枚举状态。
源文件不存在时直接返回 `file_login_unavailable`，指引用户确认已登录且凭据采用文件
存储，不尝试读取宿主 config 来区分未登录与 keyring。

CLI provider 不可用不会阻止单用户控制台启动，否则用户无法进入页面修复配置；但
引用该 provider 的岗位必须在领取工作前失败关闭并显示 degraded/owner attention，
不能回退到更弱的大脑。系统状态可将它显示为非秘密的能力告警。

## 14. 与主控、员工和 PR 工程师的关系

认证方式只改变模型请求如何登录，不改变岗位权力：

- 主控仍只负责观察、判断、拆分、路由、咨询、移交和跟踪；
- 员工仍只能返回领域允许的结构化意图；
- CLI 不能直接读取宿主仓库，不能运行 Git/`gh`，不能访问 GitHub；
- Code Job 仍由受控执行器在隔离工作区实施，并经过验证、台账和确认；
- GitHub 读取和写入仍由独立 adapter 与逐项确认处理；
- PR #23178 的真实验收只能由重启后的 MyDashboard 自身领取和执行；Codex 开发
  会话不得代替系统访问该 PR；
- 在负责人另行逐项确认前，禁止评论、Review、更新分支、push、merge 或源仓库
  应用。

## 15. 备份、恢复与开源边界

- 凭据镜像不进入 BackupService 的 owner registry，也不进入离线恢复包；
- 恢复到另一机器后，系统显示 Codex 登录不可用，要求该机器当前服务用户自行登录；
- 备份清单、manifest、日志和校验报告必须证明没有凭据目录或文件；
- clean-room、npm pack 和开源隐私扫描必须在没有登录缓存时仍能完整运行；
- 示例配置可以展示 `credentialMode: "codex-login"`，但不能包含真实路径、账号或
  secret；
- 卸载或明确退出 MyDashboard 的凭据代理时可删除私有镜像，但不得删除宿主
  `~/.codex/auth.json`。

## 16. 测试与验收

实现必须以 TDD 完成以下证据。

### 16.1 配置与页面

- 缺失字段保持旧 `api-key` 行为；新 Codex 模板默认 `codex-login`；
- 非法 kind/mode 组合、秘密值和路径字段精确失败；
- `credentialMode` 进入影响预览、逐项确认和 restart-required；
- 浏览器可创建、编辑、确认并重载该 provider；无 token/path/account DOM 泄漏。

### 16.2 登录源与镜像

- 普通当前用户文件通过；缺失、空文件、超限、短读、替换、symlink、junction、
  hardlink、错误 owner 和危险写 ACL 失败；
- 读取和发布中的 TOCTOU 竞争失败关闭；
- envelope 原子替换的每个崩溃窗口只留下旧完整状态或新完整状态；
- 临时文件扫描有总条目、深度和字节上限；
- logout、重新登录、账号源变化、临时不可读与损坏镜像符合第 8、11 节规则；
- 所有错误、日志、审计和测试快照不含凭据或私有路径。

### 16.3 Provider 集成

- login 模式子环境只增加 invocation-local `CODEX_HOME`，不含任何 API/GitHub/Git/
  SSH 凭据；
- API-key 模式保持当前精确环境；
- 宿主 config、rules、plugins、MCP、skills、sessions 和仓库均不可见；
- 模拟 Codex 刷新 `auth.json` 后，下一任务和重建后的 runtime 使用刷新结果；
- 同身份并发严格串行，FIFO、deadline、取消、close 和 cleanup 无泄漏；
- 数据分类拒绝发生在凭据读取、locator 和 spawn 之前；
- malformed 输出仍只启动一次 CLI，且不得触发修正重试或弱模型回退。

### 16.4 真实本机但无模型的验证

- 通过生产 KnownCliLocator 解析安装的 Codex 0.147.x；
- 在隔离 profile 中仅执行固定 `codex login status`，证明镜像可被真实 CLI 识别；
- 不发起模型请求，不访问 PR，不修改宿主登录文件；
- 验证结束后任务目录删除，私有镜像 ACL 与完整性保持有效。

### 16.5 全系统验收

- CLI focused、配置、composition、员工、Code Job、备份/恢复、开源分发测试通过；
- 完整 `npm test`、全部 JavaScript syntax、UI validator 与 Docker gate 通过；
- 干净本地镜像复跑且工作树保持 clean；
- 独立安全/正确性审查无 P0/P1/P2；
- 受管重启到精确已验收 HEAD；
- 由产品自身使用已确认的 Codex `taskBrain` 对 PR #23178 完成只读验收；
- 证明没有评论、Review、分支更新、push、merge 或源仓库应用。

## 17. 实施顺序

书面规格批准后，另行编写可执行 TDD 计划，至少拆为：

1. 配置契约、影响分类和页面模板；
2. 私有凭据镜像与宿主源准入；
3. 串行租约、一次性 profile 和刷新回收；
4. 生产组合、生命周期与 sanitized readiness；
5. 浏览器、备份/恢复和开源边界；
6. 真实 `login status`、完整回归、干净镜像与独立审查；
7. 受管重启、页面逐项确认和产品自身 PR #23178 只读验收。

每一阶段先保留 RED，再做最小实现到 GREEN，再进行作用域审查；任何新发现的权限、
凭据、进程生命周期或恢复缺陷都必须在进入真实任务验收前关闭。

## 18. 已决策事项

- 采用凭据代理，不挂载完整宿主 profile。
- 允许自动检测宿主登录变化，但只在任务边界切换。
- 刷新结果只写 MyDashboard 私有镜像，不写回宿主 Codex 文件。
- 同一 Codex 登录身份第一版串行执行。
- 旧 provider 保持 API-key，有意识地通过页面切换到 `codex-login`。
- 第一版仅支持 Codex 文件式登录；Claude 登录与 keyring 另行设计。
- 页面仅显示能力状态，不显示身份和凭据细节。
- 认证不授予仓库、GitHub、命令或外部动作权限。

本规格没有剩余的产品形态选择；下一门禁是负责人确认本文准确表达已批准方案。
