# MyDashboard

本机个人研发指挥中枢，把 GitHub PR、Issue、里程碑/Release 与钉钉 @我、待办、未读会话合并为行动队列，并运行一个可暂停、可追踪的 PR 推进员工。

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

## PR 推进员工

- 每 2 分钟巡查一次最新的成功 GitHub PR 快照；旧快照或失败源不会触发新工作。
- 对需要 Review 的 PR 读取固定 head 的有限 diff，生成评审草稿并进入逐条确认弹窗。
- 对自己创建且需要推进的 PR 读取结构化元数据，生成本地执行方案。
- 接受/拒绝当前只保存为本地决策，**不会提交 GitHub Review，也不会修改远端 PR**。
- 作业带 revision、head 校验、运行租约和重试策略；模型完成后若 head 已变化，草稿会自动失效。
- 分析、证据、步骤、来源 URL、head 和所用大脑会写入本地记忆，可在“记忆搜索”中查询。

岗位默认继承全局 `brain`，也可以在 `employees.prReviewer.brain` 中覆盖模型。例如只给 PR 岗位换一个更强的本地 Ollama 模型：

```json
{
  "employees": {
    "prReviewer": {
      "brain": {
        "enabled": true,
        "provider": "ollama",
        "model": "更强的本地模型名"
      }
    }
  }
}
```

当前实现的岗位大脑适配器是 Ollama；岗位与模型已经解耦，后续可以增加第三方 Provider，而不改变作业状态机和确认边界。

PR 正文、文件名和 diff 默认只允许发送到 loopback Ollama。若明确要连接远程 Ollama，必须在 `employees.prReviewer` 中设置 `allowRemoteCodeContext: true`；界面会持续提示代码上下文正在离开本机。远程 Provider 后续也应沿用这一显式授权边界。

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
