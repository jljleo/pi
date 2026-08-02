# pi-mono 系统架构图

> 配套文档:`STUDY_PLAN.md`(6 周手抄计划,agent 开发导向)、`CODE_READING_ROUTE.md`(代码浏览路线表)。
> 本文所有符号(类名/函数名/事件名)均与源码一一对应,可直接跳转。
> agent 开发导向的读者:第 1-7、11 节为必读;第 8 节(TUI)、第 9 节后半、第 10 节(外围)只需建立概念,可略读。

---

## 1. 分层总览

```
┌─────────────────────────────────────────────────────────────────────┐
│ 产品层   packages/coding-agent  (pi CLI,55,559 行)                  │
│          cli.ts → main.ts → AgentSession → 三种运行模式              │
│          interactive(TUI) / print(一次性) / rpc(供 server 调用)    │
├─────────────────────────────────────────────────────────────────────┤
│ UI 层    packages/tui  (自绘终端 UI 库,12,214 行,零 TUI 框架依赖)  │
│          TUI 主类 + Terminal 抽象 + 组件(editor/markdown/...)       │
├─────────────────────────────────────────────────────────────────────┤
│ 运行时层 packages/agent  (通用 agent 运行时,10,028 行)             │
│          agentLoop 双层循环 + Agent 类 + harness(工具/压缩/会话)    │
├─────────────────────────────────────────────────────────────────────┤
│ 抽象层   packages/ai  (LLM provider 抽象,21,327 行)                │
│          统一消息类型 + EventStream + 各厂商 wire 协议适配           │
└─────────────────────────────────────────────────────────────────────┘
  外围设施(复刻 CLI 可跳过):
  packages/server(多实例守护,IPC)   packages/storage/sqlite-node(SQLite 后端)
  packages/evals(评测 harness)
```

## 2. 包依赖方向(compile-time)

```
        ┌──────┐
        │  ai  │  叶子包,不依赖任何内部包
        └──▲───┘
           │ @earendil-works/pi-ai
        ┌──┴───┐         ┌──────────────────────┐
        │ agent│ ◄────── │ storage/sqlite-node  │ (实现 agent 定义的
        └──▲───┘         └──────────────────────┘  SessionStorage 接口)
           │ pi-agent-core
   ┌───────┴────────┐
   │  coding-agent  │ ◄── tui(只被 coding-agent 依赖)
   └───────▲────────┘
          │ pi-coding-agent
      ┌───┴────┐
      │ server │  (fork rpc-entry 子进程,unix socket IPC)
      └────────┘
  evals:无依赖,通过脚本跑 coding-agent 构建产物
```

关键设计:**依赖严格单向、无环**。ai 不知道 agent 的存在,agent 不知道 TUI 的存在——上层可替换,下层可独立复用(`pi-ai`、`pi-agent-core`、`pi-tui` 都单独发 npm 包)。

---

## 3. 启动序列(interactive 模式)

```
$ pi
 │
 ▼
coding-agent/src/cli.ts            bin 入口:进程级环境设置(20 行)
 │ import
 ▼
coding-agent/src/main.ts  main()   阶段 0-8(916 行,已注释):
 │                                  ① 子命令分流 ② 解析 args(cli/args.ts)
 │                                  ③ 判定模式 ④ 会话解析、确定 cwd
 ▼
core/agent-session-services.ts     依赖注入装配:SettingsManager、
   createAgentSessionServices()     ModelRegistry、SessionManager、扩展加载……
 │
 ▼
core/agent-session.ts              会话总控(3,332 行,已注释):
   createAgentSession()             构造 AgentSession,注入全部协作者,
 │                                  订阅底层 Agent 事件并转发
 ▼
模式分发(main.ts 尾部):
 ├─► modes/interactive/interactive-mode.ts   new InteractiveMode()(6,060 行)
 │     └─► new TUI()(pi-tui)→ 挂载 editor/markdown/loader 组件
 │           └─► 订阅 AgentSessionEvent → 渲染
 ├─► modes/print-mode.ts  runPrintMode()     -p 一次性输出(159 行,最小链路)
 └─► modes/rpc/           runRpcMode()       JSON-RPC over stdio(供 server)
```

---

## 4. 核心数据流:一次流式响应的一生

这是整个系统最重要的一条链,五级事件逐级抬升抽象层次:

```
 LLM 服务器
    │  HTTP SSE 字节流(text/event-stream)
    ▼
┌─ ai/src/api/anthropic-messages.ts ─────────────────────────┐
│ streamAnthropic()  手写 SSE 解码器逐事件解析               │
│ 增量拼装 text / thinking / tool_use 块                     │
└──────────────────────────┬─────────────────────────────────┘
                           │ push
                           ▼
  ai/src/utils/event-stream.ts   AssistantMessageEventStream
  (EventStream<T,R>:push 式生产 / AsyncIterable 消费)
                           │ ① AssistantMessageEvent(12 种):
                           │   start / text_start / text_delta / text_end
                           │   thinking_* / toolcall_* / done / error
                           ▼
┌─ agent/src/agent-loop.ts  runLoop() ───────────────────────┐
│ 消费流,累积成完整 AssistantMessage,发 ② AgentEvent(10 种):│
│ agent_start/end、turn_start/end、                          │
│ message_start/update/end、tool_execution_start/update/end  │
└──────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
┌─ coding-agent/src/core/agent-session.ts ───────────────────┐
│ _handleAgentEvent():先转发给扩展(extensionRunner.emit),  │
│ 再包装成 ③ AgentSessionEvent(增加 queue_update、          │
│ compaction_*、auto_retry_*、agent_settled 等)              │
│ 同时把消息追加到 SessionManager(jsonl 持久化)              │
└──────────────────────────┬─────────────────────────────────┘
                           │ subscribe 回调
                           ▼
  modes/interactive/ 或 print-mode    UI 按事件渲染(打字机效果、
                                      工具面板、loader、用量统计)
```

记忆口诀:**字节 → SSE 事件 → AssistantMessageEvent → AgentEvent → AgentSessionEvent → 屏幕**。每一层只做一件事:解析、累积、编排、转发、渲染。

---

## 5. agent loop 双层循环(全仓心脏)

文件:`agent/src/agent-loop.ts`(792 行,已注释)

```
runAgentLoop(config) ──► 返回 EventStream<AgentEvent, AgentMessage[]>
 │
 ▼
runLoop():
 ┌──────────── 外层循环(while true)────────────────────────┐
 │  agent_start                                             │
 │  ┌──────── 内层循环:单个 turn ────────────────────────┐  │
 │  │ turn_start                                          │  │
 │  │   stream = config.streamFn(model, context, options) │  │
 │  │   for await (event of stream)  ── 累积 partial      │  │
 │  │     └─ emit message_update(assistantMessageEvent)   │  │
 │  │   得到完整 AssistantMessage                         │  │
 │  │                                                     │  │
 │  │   if (没有 tool_calls) ──► turn_end,跳出内层       │  │
 │  │                                                     │  │
 │  │   if (stopReason === "length")                      │  │
 │  │     ──► 整批 tool call 标记失败(输出被截断,        │  │
 │  │         参数 JSON 可能不完整,不允许执行)            │  │
 │  │                                                     │  │
 │  │   executeToolCalls():                               │  │
 │  │     逐个取出 tool_call → 校验参数(schema)          │  │
 │  │     → tool.execute(args, onUpdate)                  │  │
 │  │     → emit tool_execution_start/update/end          │  │
 │  │   工具结果作为 ToolResultMessage 追加到 context      │  │
 │  │   ──► 回到内层循环顶部,再次 stream(模型看到结果)  │  │
 │  └─────────────────────────────────────────────────────┘  │
 │                                                           │
 │  内层结束(模型不再调工具)后:                            │
 │  if (有排队的 follow-up 消息) ──► 注入 context,继续外层  │
 │  else ──► agent_end(携带本次全部新消息),返回            │
 └───────────────────────────────────────────────────────────┘
```

三个最值得抄的细节:
1. **工具结果回填即继续**:内层循环没有出口条件判断,靠"没有 tool_calls"自然结束。
2. **stopReason=length 整批拒执**:截断的 tool call 参数是不完整 JSON,执行可能损坏文件,宁可全部报错让模型重试。
3. **外层循环的唯一职责是 follow-up**:用户/插件在运行中追加的消息,等当前 agent 收尾后再开一轮。

---

## 6. 工具系统管线

```
定义(两处,同一范式):
  agent/src/harness/tools/*.ts        通用版(read/bash/edit/write/image)
  coding-agent/src/core/tools/*.ts    产品版(加权限、截断、TUI 渲染)

  每个工具 = typebox schema(参数,同时生成 JSON Schema 和 TS 类型)
           + execute(args, onUpdate) 函数
           + (产品版)renderCall/renderResult(TUI 展示)

注册:
  coding-agent/src/core/tools/index.ts   createXxxTool 工厂汇总
       │ 传入 AgentLoopConfig.tools
       ▼
运行(agent-loop.ts 内):
  ① system prompt 附带工具的 JSON Schema ──► LLM
  ② LLM 流式输出 tool_use 块(toolcall_delta 增量拼 JSON)
  ③ 内层循环收齐后 executeToolCalls():
       参数 schema 校验 ──失败──► 错误结果直接回填(让模型自我纠错)
       file-mutation-queue 串行化写操作(防并发写冲突)
       edit:先精确匹配后模糊匹配;重叠/歧义/无变化三类冲突拒绝
       输出经 truncate.ts 行/字节双上限头尾截断
  ④ ToolResultMessage 回填 context,进入下一 turn
```

---

## 7. coding-agent 内部模块图(src/ 下)

```
cli.ts / main.ts                 入口与分发
cli/      args.ts、session-picker、startup-ui
core/
  agent-session.ts               ★ 会话总控(3,332 行)
  agent-session-services.ts      DI 装配
  agent-session-runtime.ts       运行时辅助
  session-manager.ts             jsonl 会话树持久化(1,712 行)
  settings-manager.ts            分层设置(1,234 行)
  model-registry/                模型目录与解析
  compaction/                    压缩编排(核心算法在 agent 包)
  extensions/                    扩展系统(types.ts + runner.ts,钩子机制)
  tools/                         产品级工具(见第 6 节)
  hooks/、sdk.ts                 对外编程接口
modes/
  interactive/                   TUI 装配(6,060 行主文件 + components/)
  print-mode.ts                  最小链路(先读这个!)
  rpc/                           JSON-RPC(server 用)
utils/    git、clipboard、image、syntax-highlight(略读)
```

`AgentSession` 的职责全景(已注释,见文件顶部块注释):

```
构造/DI ── 事件订阅转发(agent→扩展→UI→持久化)── 消息发送/排队/中断
── 会话树持久化(SessionManager)── 压缩(手动/阈值/溢出恢复)
── 模型与思考等级切换 ── 指数退避自动重试 ── bash 执行 ── 分支导航/导出
```

---

## 8. TUI 渲染架构(packages/tui)

```
终端字节流                                   屏幕
    ▲                                          ▲
    │ parse                                     │ write(差量)
keys.ts ──► KeyEvent ──► keybindings.ts ──► TUI 主类(tui.ts)
(转义序列→结构化按键)   (按键→动作 ID,可配置)   │
                                              ├─ 组件树:Component 接口
                                              │    render(): 文本行[]
                                              │    handleInput(key)
                                              │    ├─ editor.ts(多行编辑器,
                                              │    │   行数组存储、UTF-16 光标、
                                              │    │   快照式撤销、宽字符处理)
                                              │    ├─ markdown.ts(marked token
                                              │    │   → ANSI 样式行)
                                              │    └─ loader/select-list/...
                                              ├─ 渲染循环:状态变更 → 标记脏
                                              │    → 下一 tick doRender()
                                              │    → 逐行差量比对 → 只写变化的行
                                              └─ terminal.ts(raw mode、ANSI、
                                                  Kitty 键盘协议、尺寸探测)
```

零框架自绘的代价与收益:完全控制渲染时序(流式打字机不闪屏),代价是要自己处理宽字符、差量、焦点——`editor.ts` 2,351 行主要就花在这里。

---

## 9. 会话持久化(会话树)

```
agent/src/harness/session/           通用抽象
  SessionStorage 接口 ◄── jsonl-storage.ts(append-only 事件日志)
                      ◄── memory-storage.ts(测试用)
coding-agent/src/core/session-manager.ts   产品实现
  每个会话一个 .jsonl 文件,每行一个 SessionEntry
  entry 带 parentId ──► 会话是树不是线:
    分支(navigateTree)= 回到任意节点继续,天然支持 undo/fork
  压缩 = 生成摘要 entry,指向被压缩的区间
事件流里穿插 entry_appended,UI 与磁盘始终一致
```

---

## 10. 外围设施(选读)

```
server/        pi serve:unix socket 守护;每个实例 fork rpc-entry 进程,
               supervisor.ts 管理生命周期 —— 把 coding-agent 变成多客户端服务
storage/       SessionStorage 的 SQLite 实现(agent 包接口的另一种后端)
evals/         vitest 自定义 reporter + 评测脚本,验证模型在 pi 上的表现
```

---

## 11. 关键技术决策速查

| 决策 | 位置 | 为什么 |
|---|---|---|
| Node strip-only 模式跑 .ts | tsconfig.base.json | 免构建步骤,源码即可执行;代价:禁用 enum/namespace |
| 导入带 `.ts` 后缀 | 全仓 | NodeNext 解析要求 |
| EventStream push/pull 桥接 | ai/utils/event-stream.ts | SSE 是 push,业务逻辑要 for-await 的 pull |
| 统一消息抽象 | ai/types.ts | 加新厂商只需写一个 api/ 适配器 |
| 工具 schema 单一来源 | typebox | JSON Schema(给 LLM)与 TS 类型(给编译器)不漂移 |
| 事件驱动 UI | AgentEvent/AgentSessionEvent | print/TUI/rpc 三模式共用同一引擎 |
| jsonl 会话树 | session-manager.ts | append-only 崩溃安全;树结构天然支持分支 |
| 自绘 TUI | tui 包 | 流式渲染时序完全可控 |
