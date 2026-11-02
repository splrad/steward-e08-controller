# 工作流验证

中央 [Native Validation](../.github/workflows/pr-validation-native.yml) 从 `job.workflow_repository`、`job.workflow_sha`、`job.workflow_file_path` 取得受信源 P，检出准确的候选 head H。PR 基点还必须与检出时的目标分支一致；main push 使用事件的 before/after。Git 完整读取 NUL 分隔的变更，保留重命名两端；缺失对象、浅克隆或来源不符都会失败。

[范围选择器](../scripts/select-validation-scope.mjs) 是纯函数，只决定 source、dependency、docs、governance 及理由。文档通常只运行链接检查；治理输入、共享依赖、构建入口和未知影响路径运行较完整检查。源码 job 中直接运行 npm 验证或 Windows .NET restore/build，治理 job 执行 JSON/YAML、AGENTS 和实际工作流扫描。Windows 还解析 PowerShell/MSBuild 文件。

jactionlint、shellcheck、pyflakes 与 zizmor 使用中央锁定工具扫描真实 YAML。候选的忽略配置不能关闭检查。标题入口按已批准的 `E07-TITLE-METADATA-20261028` 固定元数据例外处理；原始诊断、退出码和其他失败保留。扫描工具直接支持 queue 和 `job.workflow_*`，无需旧的工作流镜像或任务解释器。

治理提升另按 `E07-PROMOTION-WORKFLOW-RUN-20261031` 处理固定入口的 workflow_run 诊断：候选与可信 P 的该工作流语义比对，只允许既有项目完整 Action SHA 和 mise 正式版本更新。路径、来源、权限、执行步骤、凭据和缓存/产物变体继续失败。具体边界见 [治理提升](governance-promotion.md)。

dependency-review 比较准确 base/head，采用 high 阈值，覆盖 runtime、development、unknown，等待原生快照告警最多 600 秒，不回写 PR。NuGet 实际直接/传递覆盖和组织 required workflow 的平台强制仍须在隔离及线上采用阶段取证。

DOC-LINK 读取改变的当前文档及受影响目标的当前引用。lychee 校验本地路径、图片和可识别锚点；Linux 联网前必须通过原生 nft check/load，保留计数器并仅清理本任务的表。网络子进程使用最小环境。历史文件只检查本地引用，外部 404/410 和未知响应保留在报告中。

每个原生 job 都返回真实结果；不适用项由完整范围证据说明。最终 `SPLRAD Validation` 拒绝失败、取消、结果缺失或异常跳过。main 成功后的治理采用由 [governance-promotion](governance-promotion.md) 独立完成。
