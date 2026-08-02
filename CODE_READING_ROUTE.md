# pi-mono 代码浏览路线表(agent 开发导向)

> 配套文档:`ARCHITECTURE.md`(系统架构图)、`STUDY_PLAN.md`(6 周手抄计划)。
> 用法:本文是"读"的导航,`STUDY_PLAN.md` 是"抄"的日程。每条路线先按跳转链通读(源文件已带中文注释),再按计划表手抄。读完用"出口标准"自测,答不出就回读。
>
> 本版已按 agent 开发目标裁剪:TUI 深读、interactive-mode、server/storage/evals 等路线已移除(保留 TUI 1 小时概念速览,见 R7)。

---

## 路线总表

| # | 路线 | 对应周次 | 预计 | 一句话 |
|---|---|---|---|---|
| R0 | 启动链路追踪 | 第 1 周 D1 | 0.5 天 | 从 `pi` 命令到模式分发,只看不抄 |
| R1 | 类型地基 | 第 1 周 | 2 天 | 统一消息抽象 + EventStream |
| R2 | 一次流式请求的一生 | 第 2 周 | 3 天 | provider 调用与 SSE 解析 |
| R3 | agent loop 心脏 | 第 3 周 | 3 天 | 双层循环逐行 |
| R4 | 工具系统 | 第 4、5 周 | 3 天 | 通用版 → 产品版对比 |
| R5 | 压缩与会话持久化 | 第 4 周 | 2 天 | token 上限与 jsonl 会话树 |
| R6 | 装配层总控 | 第 5 周 | 3 天 | AgentSession 三大段攻克 |
| R7 | 运行模式与 TUI 概念速览 | 第 5 周 | 1 天 | print 最小链路 + TUI 只建立概念 |
| — | mini-pi 毕业设计 | 第 6 周 | 7 天 | 不看原码独立实现,见 STUDY_PLAN |

阅读三条总原则:
1. **自底向上**:ai → agent → coding-agent,依赖方向不可逆。
2. **先类型后流程**:每个包先读 `types.ts`,再读流程代码;类型是这个项目的"合同"。
3. **先主干后分支**:第一遍只追 happy path,第二遍再看错误处理/边界条件。

---

## R0 启动链路追踪(第 1 周 D1,0.5 天)

目标:不读细节,把一次启动的跳转链走一遍,建立全局地图。

跳转链(每站只看顶部块注释 + 主函数签名):

```
cli.ts (20 行)
  → main.ts main():找"阶段 0-8"注释,看模式分发 if/else
  → core/agent-session-services.ts createAgentSessionServices():看装配了哪些服务
  → core/agent-session.ts createAgentSession():只看函数签名和返回的 AgentSession
  → modes/print-mode.ts runPrintMode():最小链路全貌
```

出口标准:能脱稿画出 `ARCHITECTURE.md` 第 3 节的启动序列图。

---

## R1 类型地基(第 1 周,2 天)

| 顺序 | 文件 | 关键符号 | 阅读要点 |
|---|---|---|---|
| 1 | `ai/src/types.ts`(793 行) | `Message`、`AssistantMessage`、`ToolCall`、`ToolResultMessage`、`Usage`、`StopReason`、`StreamFunction`、`StreamOptions` | 全仓"普通话"。注意 content 是块数组(text/thinking/toolCall),不是字符串 |
| 2 | `ai/src/types.ts` 尾部 | `AssistantMessageEvent`(12 种) | start/`*_start`/`*_delta`/`*_end`/done/error 的生命周期对称设计 |
| 3 | `ai/src/utils/event-stream.ts`(88 行) | `EventStream<T,R>`、`AssistantMessageEventStream` | push 式生产 / `for await` 消费的桥;`result()` 取最终值 |
| 4 | `ai/src/models.ts`(705 行) | `Provider`、`Models`、`createProvider()`、`dispatch()`、`stream` vs `streamSimple`、`calculateCost()` | dispatch 按 `model.api` 字符串选 `api/*.ts` 实现,加新厂商不改这里 |

自测:① 为什么 `StreamFunction` 返回 `EventStream` 而不是 Promise?② `done` 和 `error` 事件的 reason 各覆盖哪些 StopReason?③ `streamSimple` 与 `stream` 的区别是什么?

略读:`models.generated.ts`、所有 `*.models.ts`、`providers/data/*.json`(生成物)。

---

## R2 一次流式请求的一生(第 2 周,3 天)

主线精读 `ai/src/api/anthropic-messages.ts`(1,351 行),对照略读 `openai-completions.ts`(1,518 行)。

anthropic-messages.ts 推荐分段顺序(源文件顶部块注释有同样导读):

| 顺序 | 段落 | 看什么 |
|---|---|---|
| 1 | 文件顶部块注释 | 出站翻译链 / 入站解析链全景 |
| 2 | 主入口 stream 函数 | 如何创建并返回 AssistantMessageEventStream |
| 3 | 请求体构造 | 统一 `Context` → Anthropic 请求:system 提取、消息翻译、工具定义、thinking 配置、prompt 缓存标记 |
| 4 | SSE 解析主循环 | 按 event 类型分发:`content_block_start/delta/stop`、`message_delta`、`message_stop` |
| 5 | tool_use 增量拼装 | `input_json_delta` 分片累积成完整参数 JSON(对比 OpenAI 的 `function.arguments` delta,协议不同、范式相同) |
| 6 | stop reason / usage 映射 | 各家词汇 → 统一 `StopReason`/`Usage` |
| 7 | 错误与重试 | `utils/` 的 retry 如何包住整个流 |

对照阅读(只读不抄):`openai-completions.ts` 的 tool call delta 累积、`include_usage` 流式用量、各 OpenAI 兼容厂商的 compat 开关。

最后读 `ai/src/providers/faux.ts`(541 行):脚本化假 provider,FIFO 响应队列 + delta 模拟——后面跑 coding-agent 测试全靠它,理解它才能读懂测试。

自测:① 一个 tool_use 块从 SSE 字节到 `toolcall_end` 事件经历哪几步?② 为什么 thinking 块要和 text 块分开成独立 content?③ 如果 SSE 连接中途断开,事件流以什么事件收尾?

略读:`api/*.lazy.ts`(懒加载样板)、`legacy-api-aliases.ts`、`compat.ts`、`auth/`(需要时再回来)。

---

## R3 agent loop 心脏(第 3 周,3 天)

| 顺序 | 文件 | 关键符号 | 阅读要点 |
|---|---|---|---|
| 1 | `agent/src/types.ts`(437 行) | `AgentTool`、`AgentEvent`(10 种)、`AgentLoopConfig`、`StreamFn` | AgentEvent 与 AssistantMessageEvent 的层次差异(轮次/工具生命周期是新增抽象) |
| 2 | `agent/src/agent-loop.ts`(792 行) | `agentLoop()`、`agentLoopContinue()`、`runAgentLoop()`、`runLoop()`(内部)、`executeToolCalls()` | 对照 `ARCHITECTURE.md` 第 5 节逐行读;三个细节:结果回填即继续、length 整批拒执、外层只管 follow-up |
| 3 | `agent/src/agent.ts`(577 行) | `Agent` 类 | 函数式 loop 的 OO 封装:状态持有、队列、中断。理解它与 runAgentLoop 的分工即可 |

自测:① 默写双层循环骨架(伪代码即可)。② 模型连续两轮都请求工具时,事件序列长什么样?③ 用户在中途按 Esc 中断,`aborted` 从哪一层开始传播?

验证:读并单跑 `agent/test/` 下 agent-loop 相关测试。

---

## R4 工具系统(第 4 周 + 第 5 周对比,3 天)

**第 4 周先读通用版**(`agent/src/harness/tools/`):

| 顺序 | 文件 | 阅读要点 |
|---|---|---|
| 1 | `tool-context.ts` + `index.ts`(小) | 工具如何被注册成 AgentTool 列表 |
| 2 | `read.ts`、`write.ts` | 最小完整范式:typebox schema + execute |
| 3 | `bash.ts` | 子进程、超时、输出截断 |
| 4 | `edit.ts` + `edit-diff.ts` | 先精确后模糊匹配;重叠/歧义/无变化三类冲突;这是 coding agent 最重要的工具 |
| 5 | `file-mutation-queue.ts` | 写操作串行化,防并发写冲突 |
| 6 | `image.ts`、`path-utils.ts` | 了解即可 |

**第 5 周对比读产品版**(`coding-agent/src/core/tools/`,15 个文件):

带着问题读:产品版比通用版多了什么?(答案:权限/环境变量隔离、output-accumulator、truncate.ts 行/字节双上限、render-utils 的 TUI 渲染、tool-definition-wrapper 包装)

自测:① 从零写一个 `createTodoTool` 需要哪几部分?② edit 工具为什么宁可报错也不做"尽力替换"?③ 工具执行出错为什么不 throw 而是回填错误结果?

---

## R5 压缩与会话持久化(第 4 周,2 天)

| 顺序 | 文件 | 阅读要点 |
|---|---|---|
| 1 | `agent/src/harness/compaction/compaction.ts`(880 行) | 何时触发(token 估算/阈值)、切割点选择(不拆散 tool call 对)、摘要 prompt、压缩后上下文重组 |
| 2 | `agent/src/harness/session/session.ts` → `jsonl-storage.ts` → `jsonl-repo.ts` | 接口→实现→读写细节;append-only 为什么崩溃安全 |
| 3 | `agent/src/harness/session/memory-*.ts` | 同一接口的内存版,测试怎么用 |
| 4 | `coding-agent/src/core/session-manager.ts`(1,712 行) | **只读主干**:entry 带 parentId 成树、分支导航、压缩 entry。产品级细节知道职责即可 |

自测:① 为什么压缩不能随便选切割点?② 会话"分支"在 jsonl 里如何表示?③ 崩溃恢复后,会话树为什么不会丢尾部之外的数据?

---

## R6 装配层总控(第 5 周,3 天)

`coding-agent/src/core/agent-session.ts`(3,332 行)分七段,**段 2/3/4 精读,其余通读**。文件顶部块注释有同样的分区图:

| 段 | 主题 | 读法 | 重点方法(带下划线前缀为私有) |
|---|---|---|---|
| 1 | 构造与 DI | 通读 | `createAgentSession()`、构造函数:协作者清单及各自来源 |
| 2 | 事件订阅与转发 | **精读** | `_handleAgentEvent()`:agent→扩展→UI→持久化的转发顺序为什么是此序 |
| 3 | 消息发送/排队/中断 | **精读** | `prompt()`、队列机制、`abort()`:运行中发消息如何变 follow-up |
| 4 | 压缩触发 | **精读** | `_checkCompaction()`、`_runAutoCompaction()`:手动/阈值/溢出三条触发路径 |
| 5 | 模型与思考等级 | 通读 | 切换模型时上下文和 usage 怎么处理 |
| 6 | 自动重试 | 通读 | `auto_retry_start/end`、指数退避、`_willRetryAfterAgentEnd()` |
| 7 | 分支导航与导出 | 通读 | `navigateTree()`:会话树如何配合 SessionManager |

前置:`cli/args.ts`(0.5 小时)+ `agent-session-services.ts`(0.5 小时)。

自测:① 列出 AgentSession 的全部协作者及来源。② 一个 AgentEvent 从 agent-loop 到屏幕经过哪几次包装?③ 自动重试和压缩溢出恢复分别在什么事件之后触发?

略读:`settings-manager.ts`、`model-registry/`(知道职责即可)。

---

## R7 运行模式与 TUI 概念速览(第 5 周,1 天)

| 顺序 | 文件 | 读法 | 阅读要点 |
|---|---|---|---|
| 1 | `modes/print-mode.ts`(159 行) | **全文精读** | 最小可用链路:订阅事件→收集输出→退出码。看懂它就看懂了"没有 TUI 的 pi" |
| 2 | `core/extensions/types.ts` + `runner.ts` | 概读主干 | 扩展钩子挂在事件转发链的哪一环(R6 段 2 已见过调用方) |
| 3 | `tui/src/tui.ts` 顶部块注释 + `doRender()` 主干 | 1 小时概念速览 | 只需建立概念:组件 `render()` 产出行 → 差量比对 → 只写变化的行。**不读 editor.ts/keys.ts/markdown.ts 细节**——那是终端 GUI 编程,与 agent 开发无关 |
| 4 | `modes/interactive/interactive-mode.ts` | 可选,符号跳读 | 搜 `new TUI(`、`subscribe`,看事件→组件的接线即可,6,060 行不必通读 |

自测:① 把 print-mode 改成输出 JSON 流要动哪几行?② 三种模式共享了什么、各自独有什么?③ 扩展能拦截/修改哪些事件?

---

## 附录:核心符号速查表(agent 开发必备)

| 符号 | 位置 | 一句话 |
|---|---|---|
| `Message`/`AssistantMessage` | ai/src/types.ts | 统一消息模型,content 为块数组 |
| `AssistantMessageEvent`(12 种) | ai/src/types.ts | 流式增量事件 |
| `EventStream<T,R>` | ai/src/utils/event-stream.ts | push 生产 / pull 消费桥 |
| `createProvider()`/`dispatch()` | ai/src/models.ts | 按 model.api 选协议实现 |
| `streamAnthropic()` | ai/src/api/anthropic-messages.ts | SSE 解析范本 |
| `AgentEvent`(10 种) | agent/src/types.ts | 轮次/工具生命周期事件 |
| `agentLoop()`/`runAgentLoop()` | agent/src/agent-loop.ts | 双层循环 |
| `executeToolCalls()` | agent/src/agent-loop.ts | 工具执行与结果回填 |
| `Agent` 类 | agent/src/agent.ts | loop 的 OO 封装 |
| `AgentHarness` | agent/src/harness/agent-harness.ts | 高层编排(引擎之上的整车) |
| compaction 主函数 | agent/src/harness/compaction/compaction.ts | 上下文压缩 |
| `main()` | coding-agent/src/main.ts | 启动与模式分发 |
| `createAgentSession()`/`AgentSession` | coding-agent/src/core/agent-session.ts | 会话总控 |
| `AgentSessionEvent` | coding-agent/src/core/agent-session.ts | 面向 UI 的事件(含 queue/compaction/retry) |
| `createXxxTool` 系列 | coding-agent/src/core/tools/index.ts | 产品级工具注册 |
| `runPrintMode()` | coding-agent/src/modes/print-mode.ts | 最小可用链路 |

以下为可选了解(agent 开发非必需):

| 符号 | 位置 | 一句话 |
|---|---|---|
| `SessionManager` | coding-agent/src/core/session-manager.ts | jsonl 会话树(产品级) |
| `InteractiveMode` | coding-agent/src/modes/interactive/interactive-mode.ts | TUI 装配 |
| `TUI`/`Terminal` | tui/src/tui.ts、terminal.ts | 渲染循环与终端抽象 |
| `Editor` 组件 | tui/src/components/editor.ts | 多行编辑器(终端 GUI 编程) |
