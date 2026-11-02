# 原生治理规则准备

`node scripts/prepare-governance.mjs native-snapshot.json native-drafts.json` 从原生回读生成 Ruleset 请求正文。脚本仅在本地生成新文件，拒绝覆盖已有输出。它用于部署准备，不参与产品运行。

输入包含基础组织 Ruleset `base`（ID `18883080`）、例外团队 `team`、完整成员列表 `members`、独立治理 App `governanceApp` 及其组织安装 `installation`、成功的 `SPLRAD Validation` 检查 `validationCheck`、已审提交 `policySha`。团队和治理 App 的 ID 必须来自实际对象；测试中的 ID 只用于夹具。`legacyCandidates` 可列出已发现的旧候选分支，每项提供准确 `repositoryId` 和 `branch`。

输出分为基础规则、独立审批规则、八条运行时规则及按仓库限定的旧候选分支规则。基础规则保留无关限制、既有检查和其他 required workflow，清空旧批准者要求；独立规则仅给单成员团队 `primary-account-approval-exception` 提供 PR 范围的批准例外。运行时规则把写入者许可与历史、删除和不可变约束分开。

`assertApprovalUnion` 校验完整有效 Ruleset 集合及旧 branch protection，识别会抵消例外的附加批准要求。调用者须先通过原生接口枚举全部适用规则；只有确认旧保护不存在的 404 才能传入 `null`，权限或网络错误必须保留为失败。该函数检查配置，真实合并操作者、失败检查、未解决线程和未归属变更的效果另以原生 PR 验证。

部署时先保存当前规则恢复点，再核对受信验证和标题入口在准确 PR/head 上的结果。新验证生效后才逐项移除被其替代的旧 Gate；脚本保留旧检查，不自动决定切换时机。请求正文使用原生 `sha` 固定 required workflow 来源。具体字段参考 [GitHub 组织 Rulesets API](https://docs.github.com/en/rest/orgs/rules)。
