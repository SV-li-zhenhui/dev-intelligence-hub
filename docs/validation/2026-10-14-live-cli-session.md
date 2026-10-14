# 实时 CLI 会话验收

## 变更

- Windows 原生登录默认接入 Codex app-server；`exec` 保留为显式兼容方式。
- 点击运行任务查看绑定线程、当前回合和实时输出；补充要求通过 `turn/steer` 送入同一回合。
- 代码任务在模型步骤之间继续显示在只读“后台作业”组，不把排队任务显示为运行。
- 复用 Windows Job Object 监管双向 stdin、超时、取消和子进程清理；保留原登录、配置及会话。
- 修正 Review 修复任务的写范围判断：配置目录允许其内部文件，冲突处理仍只允许精确文件。

## 证据

| 验证 | 结果 |
| --- | --- |
| 任务、HTTP、岗位、代码执行、原生会话等相关测试 | 602 通过；该次运行早于最终默认通道切换 |
| 最终原生通道与写范围集成测试 | 262 通过，1 个平台跳过，0 失败 |
| 最终 RPC、策略、任务详情及浏览器聚焦测试 | 38 通过 |
| 写范围回归与 broker/executor 链路 | 263 通过，1 个平台跳过，0 失败 |
| 双向 Windows 进程监管 | 19 通过；真实子进程连续收发两条中文消息，退出后其后代已回收 |

真实模型为本机 Codex CLI 0.162.1、`gpt-6.1-sol / high`，版本仅记录验收环境，不作为启动条件。

`app-server-live-d094a429-227f-44d6-b7b1-3e3c68718148/receipt.json`：

- 当前回合接受微调，实际结果为 `steered-same-turn`。
- 重建 provider 后恢复同一线程，结果为 `resumed-original-thread`。
- 原 `config.toml` SHA256 前后相同。

`app-server-review-ad7ebf98-f2d1-48eb-8e6b-64923ef24324/`：

- 使用合成 PR、本地只读 GitHub fixture 和真实模型，不向 GitHub 写入。
- 完整读取必需技能、manifest、diff，识别预置数组越界问题并返回 request_changes。
- 观察到三个线程、8 条 `subAgentActivity` 事件、两名独立审查员的结果及 MCP 读取活动。
- 关闭临时读取端点后，继续恢复同一线程成功。
- 原采集脚本只识别旧式 collab spawn，导致其 `ok` 字段为 false；补充核验使用实际 `subAgentActivity` 和线程事件，不改写原收据。

私有收据根目录为 `D:/claude/.task-run-test-tmp/testing-foundation`。早期失败收据均保留：严格配置校验拒绝旧字段，以及错误关闭 code-mode host 导致工具不可用，已分别修正；没有把失败运行计为通过。

## 审查与限制

三个独立简化审查已完成，采纳 1 项效率建议：后台详情不再重复读取同一代码任务。补充了过期/缺失 steer 回执、未知完成状态及启动前失败的验证。移动端与桌面 Chromium 验证无横向溢出，并保留草稿、光标与输出滚动位置。

Code review: skipped (ce-code-review unavailable)。本会话此前正式 CE 流程因缺少 jq、清理动作被自动审批拒绝而终止，遗留证据保留；本轮完成显式差异检查及上述独立审查。未声称完整 CE 审查完成。

没有配置 lint/typecheck 命令；执行语法及 diff 检查。T3、多机远程桌面及真实 OCT 编译/界面测试不在上述模型通道验收结果内。

用户已接手 #24723 的修复，系统提交了取消该代码作业的请求；不以它继续测试，也不恢复其自动写入。后续使用另一条 PR 核验业务链路，通道验收不等于真实 PR 修复已完成。
