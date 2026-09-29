# WorkBuddy 固定工作机协议

这个目录描述 WorkBuddy 写作任务与 GEO 后台的安全交接方式。它不保存任何第三方平台账号密码，也不包含验证码、反风控或隐式接口调用。

## 工作方式

1. 在后台为某个选题点击“WorkBuddy · 平台名”。
2. 后台创建一条十分钟有效的写作任务，包含平台规则版本、审批资料编号和写作 Brief。
3. 固定 Windows 工作机上已安装并授权的 WorkBuddy Skill 用 `GET /api/worker/tasks` 拉取任务。
4. Skill 只读取任务中的审核资料和规则，生成标题、摘要与正文；不得自行检索或补造事实。
5. Skill 用 `POST /api/worker/tasks/{taskId}/complete` 回传稿件。后台随后把稿件提交给 Codex 审核；只有审核通过后才可排期和发布。

所有请求均使用 `Authorization: Bearer <AGENT_TOKEN>`。把该值只放在 Windows 凭据管理器或 WorkBuddy 的私密配置中，不要写入 Skill 文本、源码或聊天内容。

## 给 WorkBuddy Skill 的任务指令

```text
读取 GEO 后台写作任务。只使用任务提供的 approved fact IDs 对应事实；按 ruleVersion 和平台规则完成一篇原创中文稿。不得加入未提供的数字、资质、交期、价格或比较结论。正文末尾必须保留 AIGC 辅助创作声明。完成后将 title、summary、body 回传后台；若资料不足或规则冲突，返回失败原因，不得擅自发布。
```

## 发布边界

发布器只能操作用户已经登录且可见的发布页面，或使用平台明确授权的官方接口。出现验证码、重新登录、平台警告或页面结构异常时，应回传 `attentionRequired`，后台会暂停该账号发布队列并要求人工处理。
