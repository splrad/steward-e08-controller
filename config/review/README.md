# 审查规则载体

组织 Copilot 指令维护在 [copilot-organization.md](copilot-organization.md)，全仓统一的 Codex 审查正文维护在 [AGENTS 模板](../../templates/repository/AGENTS.md)。两份 Markdown 都是完整产品稿，直接审阅和修改。各仓专项事实由自己的 CONTRIBUTING、源码、配置和验证承载。

## 组织指令采用

在获准的组织 Settings → Copilot → Custom instructions 入口保存完整组织稿，回读文本并核对来源提交。分别记录保存、目标身份消费和适用客户端的证据；文件存在或一次中文输出不能证明外部贡献者、机器人、IDE 和 CLI 都已采用。组织设置与仓库文件各有生效入口，Copier 和 safe-settings 不承担组织指令保存。

## 仓库文件采用

通过已审模板版本的 Copier 首轮采用或周期更新递送 AGENTS，全部目标保持 UTF-8、LF 和末尾一个换行。首次采用先保留旧文稿，按完整差异把专项事实迁入对应 CONTRIBUTING，再在同一采用 PR 替换公共正文并退役已归属的旧载体。未知人工内容、嵌套或 override 指令须先核对归属；不能凭文件名批量删除。

`sync-managed.yml` 的固定连接保留同一 PR 的人工提交、标题和正文。真实 Copier answers、模板 tag/SHA、Git 父链、原生签名和快进回读分别留证；实际采用前先核验该目标旧写入者已停用。生产启用与本地实现分别记录。

## 验证与恢复

`npm run verify:config` 校验中央完整稿和当前 AGENTS。现有验证入口的 `verify-review-instructions` 直接从受信中央 checkout 读取完整 AGENTS 模板，对目标文件逐字节比较，不读取候选规则注册表。缺失、CRLF、BOM、额外尾换行、目录、符号链接或待迁移载体会失败；校验不写文件。

退役前保留原始全文、准确提交和文件摘要，记录事实迁移去向；原本不存在的载体记作 already-absent。仅 ENOENT 表示本地缺失，其他读取错误不得当作迁移完成。需要恢复时从原始证据准备可审阅的文件差异，保持用户内容，分别处理组织设置与仓库文件；不以改写历史代替恢复。
