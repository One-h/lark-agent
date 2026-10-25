# 表情包检索提示词契约

## 变更目的

旧提示要求模型在看不到素材列表时判断“没有贴切候选就不声明”，
但声明正是启动检索的前提。取消这个前置要求，分离表达意图与素材匹配。

## 当前契约

- 模型依据当前请求、人设和语境决定是否使用表情。用户明确要求表情包时发起检索。
- App Server 进程通过本地 stdio 加载 `lark_stickers` MCP；不再把表情工具注册为 thread Dynamic Tools，因此旧 thread 恢复后也能使用。
- MCP `search(context_token, query)` 按需返回最多 3 个候选及预览，query 为 2–120 字符；不把全库注入上下文。
- MCP `select(context_token, sticker_id)` 只暂存当前消息与 turn 的选择。ID 必须来自最新一次搜索，null 表示取消。
- 每条消息使用随机 32 字符上下文令牌，运行器仅接受当前活动消息的令牌。MCP 不能指定 chat_id、接收人或文件路径。
- macOS 使用 sips 生成最长边 256 像素、最多 200 KB 的 PNG 预览；预览不可用时仅返回文字候选，原图不直接塞入模型。
- 选择记录保存在消息任务目录的 `sticker-selection.json`。新消息、新 turn 不复用旧选择。
- 最终文字成功送达后才发送一张选定表情。文字待重试时，媒体队列等待准确的最终文字幂等键；文字彻底失败或被替代时，停止该表情投递。
- 旧 `lark-sticker` 标签解析保留兼容，但提示词不再要求模型输出标签。工具选择优先，取消选择也会去掉旧标签。
- 纯文字和 no-reply 不强制配图。权限、审批、接收对象保持原边界，工具不接受任意接收人或本机路径。

## 验收

| 用例 | 预期 |
| --- | --- |
| 全量/增量提示词 | 都包含新的职责划分，不含提前确认候选的要求 |
| 用户明确要表情 | 提示要求发起关键词检索，不需要已有图片 ID |
| 匹配关键词 | 文字与声明分离，准备一张真实存在的图片 |
| 无匹配关键词 | 保留文字，图片为空，不伪报成功或报任务失败 |
| 纯文字/no-reply | 不自动追加表情声明 |
| 多个声明 | 仍不允许一次选择多个表情包 |
| 选择工具 | 返回待发送状态，不能立即产生飞书消息 |
| 跨消息/turn/群 | 拒绝复用其他上下文的候选和选择 |
| 文字失败重试 | 表情等待文字成功，不消耗媒体重试次数 |
| 文字终态失败/替换 | 表情不发送 |
| 重启与重复调用 | 依赖保存在 outbox payload，已发送记录不再次投递 |

自动测试：`stickerPrompt.test.ts`、`stickerTools.test.ts`、`packages/mcp-stickers/src/index.test.ts`。
真实 Codex、模拟飞书投递的隔离验收：

```bash
./node_modules/.bin/tsx scripts/verify-sticker-tools.ts
# 可选：从本机素材库只读复制三张素材到临时测试库
./node_modules/.bin/tsx scripts/verify-sticker-tools.ts --sticker-db /absolute/path/data/lark-agent.sqlite
```

脚本使用临时数据库、独立测试 thread 与端口 4783，不启动飞书监听。
它会调用真实模型并消耗模型额度，但文字与表情投递均为模拟，不向真实群发消息。
脚本保留临时产物供审查，不等同于真实飞书图片上传与回帖验收。

`npm run test:sticker-mcp-resume` 会先创建并归档一个没有 Dynamic Tools 的旧
thread，再由 Lark Agent 恢复同一个 thread 完成 MCP 搜索、选择和模拟投递，
用于防止“只在新会话可用”的回归。
