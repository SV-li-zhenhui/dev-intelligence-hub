# MyDashboard

本机个人研发指挥中枢，把 GitHub PR、Issue、里程碑/Release 与钉钉 @我、待办、未读会话合并为行动队列。系统包含可配置路由、持久化工作台账、主动员工循环、统一请示/确认队列，以及可独立配置职责、权限、调度和大脑的主控、需求、PR、开发与测试岗位。

PR 责任语义遵循团队当前流程：

- 他人创建、Assignee 是我：等待我 Review。
- 我创建的 PR：等待我修改或继续推进。
- GitHub Review request 不作为任务归属依据；避免 Assignee 已移除后仍残留在审核队列。

## 使用

```powershell
cd D:\claude\MyDashboard
npm test
npm run refresh
npm start
```

浏览器打开 `http://127.0.0.1:4173`。服务端每 10 分钟刷新，页面每分钟读取一次最新快照；“刷新”按钮可立即采集。

“跟踪版本”按版本的创建/发布时间倒序展示，最近添加或发布的记录在最上方。

## PR 能力与岗位

新的 PR 工作默认路由到持久化工作台账中的 `pr-engineer`；旧 `pr-reviewer` 保留原有数据、作业和兼容接口，不再是默认工作流目标。两个岗位首次创建都保持暂停，必须由你在“岗位”页面明确恢复后才会主动领取新工作。

旧 PR 员工的兼容链路仍保留以下能力：

- 每 2 分钟巡查一次最新的成功 GitHub PR 快照；旧快照或失败源不会触发新工作。
- 对需要 Review 的 PR 读取固定 head 的有限 diff，生成与该 Head 绑定的评审方案。
- 对自己创建且需要推进的 PR 读取结构化元数据，生成本地执行方案。
- 未启用 GitHub 写入时，评审方案只保存在本机；启用后，新方案直接进入统一外部动作确认队列，不再二次“接受草稿”。
- 作业带 revision、head 校验、运行租约和重试策略；模型完成后若 head 已变化，草稿会自动失效。
- 分析、证据、步骤、来源 URL、head 和所用大脑会写入本地记忆，可在“记忆搜索”中查询。

## 多岗位与多大脑

当前配置包含 `pr-engineer`、`orchestrator`、`requirements-analyst`、`developer` 和 `tester` 五个新岗位；每个岗位分别持久化暂停状态、运行修订号、职责、权限、调度频率和模型。默认大脑是本机 Ollama 的 `qwen3.5:9b`。

`brainProviders` 支持本地 Ollama 和 OpenAI-compatible 第三方接口。密钥只从指定环境变量读取，不写入配置或日志。例如，只给需求分析师接入第三方大脑：

```json
{
  "brainProviders": {
    "remote-smart": {
      "kind": "openai-compatible",
      "baseUrl": "https://models.example/v1",
      "apiKeyEnv": "MYDASHBOARD_MODEL_TOKEN",
      "timeoutMs": 120000
    }
  },
  "employees": {
    "roles": {
      "requirements-analyst": {
        "brain": {
          "provider": "remote-smart",
          "model": "更强的第三方模型名",
          "remoteData": {
            "requirements": true,
            "code": false,
            "memory": false
          }
        }
      }
    }
  }
}
```

远程地址必须使用 HTTPS。需求、代码和记忆三类数据分别默认拒绝出机；只有岗位的 `remoteData` 对应分类显式为 `true` 时才允许发送。页面持续显示岗位实际使用的 Provider、模型以及是否为远程大脑。旧 PR 员工的正文、文件名和 diff 仍默认只允许发送到 loopback Ollama；它的远程代码授权继续由 `employees.prReviewer.allowRemoteCodeContext` 单独控制。

## GitHub 外部动作确认

GitHub 写入默认关闭。启用后，PR 员工只能准备 `APPROVE`、`REQUEST_CHANGES` 或 `COMMENT` Review；三种动作都固定到确认时展示的 PR Head。普通 Issue Comment 写入被禁用，避免在 Head 变化后发布失去版本语境的评论。

所有外部动作都经过同一个逐条弹框。弹框会展示写入账号、仓库与 PR、Head、Review 类型、完整正文和依据；浏览器只提交队列修订号与内容摘要，不能覆盖服务端保存的动作。点击“稍后”不会产生写入，点击“确认并发布到 GitHub”后才会执行。

账号和凭据只配置在本机。`config.local.json` 保存账号、`gh.exe` 路径和凭据环境变量名，不保存 Token 本身：

```json
{
  "githubActions": {
    "enabled": true,
    "actorAccountId": "用于发布 Review 的 GitHub 登录名",
    "tokenEnv": "MYDASHBOARD_GITHUB_TOKEN",
    "ghCommand": "C:\\Program Files\\GitHub CLI\\gh.exe"
  }
}
```

在启动服务的用户环境中设置 `MYDASHBOARD_GITHUB_TOKEN`，然后重启服务。系统启动时会用该固定 Token 核对实际 GitHub 账号；账号不一致会拒绝写入。若确实需要代理或自定义 CA，必须在 `githubActions.networkEnv` 中逐项显式配置，因为携带 Token 的网络链路会随之改变。

确认队列先持久化意图，再允许外部调用；进程崩溃后会先对账再恢复。同一 Head 下若职责、下一动作或岗位策略已经变化，原岗位会先持久化失效旧确认，旧 Review 不能继续执行；结果未知时，同一 PR 的后续动作会保持阻塞，避免重复发布。启动、定时刷新、手动刷新和本地 PR 事实变更都会先关闭确认入口，只有 GitHub PR 数据健康且岗位复核完成后才重新开放。Windows 上使用 named pipe 保证同一时刻只有一个外部动作写入进程；服务关闭会先停止定时工作并等待运行时释放，崩溃时句柄由操作系统回收。

## 可配置工作流路由

GitHub PR 和 Issue 的首次观察、创建、更新、分类、状态变化、完成及离开当前范围都会转换成只包含安全事实的本地事件。刷新成功后，系统按照 `config.json` 中的 `workflowRouting` 整份规则定义进行分派，并保留事件、配置版本、分派结果和完整匹配解释。

规则按优先级从高到低判断；同优先级保持配置顺序。普通规则均未命中时才使用兜底规则。目标可以是岗位（`role`）、具体人员（`person`）或后续流程节点（`node`）；节点路由有静态环路检查、运行时已访问节点检查和最大跳数限制。当前默认把 PR 事件交给 `pr-engineer`，Issue 事件交给 `requirements-analyst`，其他事项回到本人分诊。

页面“工作流”视图可读取当前版本、规则、最新分派和审计解释，也可以用候选事件做不落盘试跑。HTTP 不提供规则替换或直接 dispatch 接口；目前修改规则需要编辑本机配置并安全重启。路由只回答“交给谁”，不会调用 GitHub、受控代码执行器或确认队列，更不能绕过外部写入与高风险执行的逐项确认。

路由状态采用进程级单写者和单调快照检查点。事件、配置、分派与审计通过内容摘要互相绑定，恢复时会拒绝回滚、分叉和损坏引用；保留策略只按完整事件包淘汰。持久化总量限制为 32 MiB，单个事件包和单条审计也有独立上限，避免异常输入无限占用本机资源。

## 主动工作循环与统一请示

路由分派会可靠写入本地工作台账。员工按租约领取工作，生成严格结构化的判断和意图，再由可信策略决定它可以咨询用户、等待条件、转交岗位、完成工作，还是只能进入受控的代码/外部动作边界。模型看不到台账租约凭据，也不能直接调用 GitHub、shell 或 HTTP 写端口。

后台顺序固定为：事实刷新、工作流路由、分派 intake、回答回流、条件唤醒、岗位判断和意图分发。工作项的领取、判断、请示、回答、等待、重试、移交和完成都有本地时间线。页面“工作台账”默认把最近工作和最近审计放在上面；对应 HTTP 只有摘要、工作项和时间线三个只读查询接口。

员工需要你决定时，会进入与 GitHub 外部动作共用的唯一弹框。每次只展示一项；回答必须带当前 revision 和内容摘要，旧页面不能覆盖已经变化的问题。“稍后”不会改变工作或执行动作。内部答复只写本地请示箱，随后由主动循环对账并继续；它不会直接执行代码或写入 GitHub。

第 6 阶段已经把五个新岗位接入主动循环和可替换大脑。相同岗位的重复定时信号会合并，事实刷新优先淘汰过期定时 tick；用户手动运行保持有界、保序，并且不会在刷新竞争中静默丢失。所有岗位目前默认暂停，先由你检查路由、权限和模型后再逐个启用。

PR Review 提案已有持久化 runner、岗位与提案类型双重权限范围，以及固定账号/仓库/PR/Head 的确认计划；只有 GitHub 外部动作总开关和 GitHub 写入开关同时开启时才会进入逐项确认。默认配置下两者关闭，不会写入 GitHub。开发和测试岗位形成的受策略约束代码提案，在用户确认精确授权后会创建持久化 Code Job，由恢复优先的本地 worker 驱动受控工具循环；变更包应用、记忆投影和完整操作界面仍属于第 7 阶段后续工作。

## 受控代码执行器

代码执行基础能力默认关闭，原始执行器、Code Job 生产端口和 worker 均不向 HTTP 暴露。启用后，开发、测试岗位也只能通过已封存的授权创建 Code Job；worker 会在每次大脑调用和新动作入场前重新核验授权，只能调用固定语义工具，并在隔离工作区内执行。启动时会先恢复持久化任务和执行器会话；恢复校验失败会直接阻止服务开放，不会退回宿主机命令执行。暂停中的已入场动作和结果未知动作只允许可信对账，不会再次询问模型或重复执行。

私人工作区和 Docker 设置只写入不入库的 `config.local.json`。下面是本项目在 Windows Docker Desktop 上的示例；镜像必须固定到 digest，工作区写权限必须逐项列出：

```json
{
  "codeExecutor": {
    "enabled": true,
    "docker": {
      "executable": "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "host": "npipe:////./pipe/dockerDesktopLinuxEngine"
    },
    "workspaces": [
      {
        "id": "my-dashboard",
        "sourceRoot": ".",
        "writablePaths": ["src", "test"]
      }
    ],
    "profiles": {
      "node-tests": {
        "kind": "node-test",
        "image": "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
        "timeoutMs": 30000
      }
    },
    "requiredProfilesByWorkspace": {
      "my-dashboard": ["node-tests"]
    }
  }
}
```

临时工作副本和不可变审计产物保存在被 Git 忽略的 `data/code-executor/`。源仓库保持只读；员工只能提交固定语义动作，不能传入任意 shell 命令。

## 本地安全边界

服务只监听 `127.0.0.1`，校验 Host、同源写请求并禁止页面被其他站点嵌入。它是单用户本地工具，当前信任同一台机器上能够访问 loopback 的本地进程；不要把 4173 端口代理或暴露到局域网/公网。

## 通知规则

- 第一次运行只建立基线，不发通知。
- 仅新增事项或关键状态变化参与通知。
- 仅优先级不低于 80 的变化发送钉钉消息。
- 每次最多 5 项，不重复播报静止状态。

配置位于 `config.json`。私人覆盖项可写入不入库的 `config.local.json`。

## 定时任务

- `MyDashboardServer`：登录时启动本地网页服务。
- `ClaudePRChatDigest`：保留原任务名以完成平滑迁移，每小时调用 `scripts\Refresh-And-Notify.ps1`；脚本只让常驻服务执行带通知刷新，服务不可用时记录失败并等待下次调度，不启动第二个写进程。

任务切换后不再调用 Claude CLI；`ClaudePRChatDigest` 的数据源和增量通知语义已内建于本项目。

`npm run refresh` 是服务停止时使用的独立维护命令；常驻服务运行期间请使用页面“刷新”或本地 `/api/refresh`，保持单写者。
