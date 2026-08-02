# pi-mono 手抄复刻学习计划(agent 开发导向,6 周)

> 目标:学习 **agent 开发**(消息抽象 → 流式协议 → agent loop → 工具 → 上下文管理),不是学终端 UI。
> 已砍掉:TUI 深读、interactive-mode、server/storage/evals、export-html、package-manager 等与 agent 内核无关的部分(砍掉的清单见文末)。
>
> 配套文档:`ARCHITECTURE.md`(系统架构图)、`CODE_READING_ROUTE.md`(代码浏览路线表)。
> 所有核心源文件已就地添加中文注释(纯注释,代码未动),读源文件即可;手抄时把注释当讲解、把代码当范本。

---

## 一、学习主线

```
ai 包(说什么话)        →  统一消息类型 + 流式协议抽象
  └─ provider 适配     →  亲手解析一家厂商的 SSE,增量拼 tool call
agent 包(怎么思考)     →  双层 agent loop:stream → 执行工具 → 结果回填 → 再 stream
  └─ harness           →  工具实现、上下文压缩、会话持久化
coding-agent(怎么落地) →  装配:事件转发、消息排队/中断、压缩触发、print 模式
毕业设计               →  不看原码写 mini-pi(300-600 行最小 coding agent)
```

## 二、每周通用方法

1. **读**:读源文件里的中文注释(每个文件顶部有导读块注释)。
2. **抄**:对照源文件逐行手敲到仓库外的独立目录(建议 `~/mini-pi/`),不许复制粘贴。
3. **默**:每抄完一个模块,合上代码默写核心骨架;写不出就是没懂,回炉。
4. **验**:单跑相关测试:`cd packages/<pkg> && node ../../node_modules/vitest/dist/cli.js --run test/xxx.test.ts`(不要跑全量套件,含 e2e 会触发真实 API)。
5. **记**:每周写一篇总结(一张模块图 + 3 个最有启发的设计决策)。

不抄的内容:生成代码(`models.generated.ts`、`*.models.ts`、`providers/data/`)、`*.lazy.ts` 样板、任何 UI 组件。

---

## 三、六周计划表

### 第 1 周|ai 包:统一抽象层(地基,务必砸实)

**目标**:理解"多家 LLM API 如何抽象成一套消息类型 + 一个流式协议"。

| 天数 | 任务(文件均已注释) | 行数 | 重点 |
|---|---|---|---|
| D1 | 准备:`npm install --ignore-scripts`,跑通 `./pi-test.sh -p "Say exactly: ok"`;读 `ARCHITECTURE.md` 全文 | — | 建立全局地图 |
| D2 | 精抄 `ai/src/types.ts` | 793 | `Message`/`AssistantMessage`/`ToolCall`/`Usage`/`StreamFunction`;content 是块数组不是字符串 |
| D3 | 精抄 `ai/src/utils/event-stream.ts`(88)+ 读 `ai/src/models.ts` | ~800 | `EventStream<T,R>` push/pull 桥;`createProvider()` dispatch |
| D4 | 精抄 `ai/src/models.ts` 主干 | 705 | `stream` vs `streamSimple`、`calculateCost()` |
| D5 | 读 `ai/src/utils/`(retry、json-parse、sanitize-unicode) | ~500 | 流式 JSON 增量解析 |
| D6 | **默写**:核心类型 + EventStream 骨架;单跑 event-stream 相关测试 | — | 本周出口 |

### 第 2 周|ai 包:provider 协议适配

**目标**:亲手实现一家厂商的 wire 协议适配,其余厂商举一反三。

| 天数 | 任务 | 重点 |
|---|---|---|
| D1-D3 | 精抄 `ai/src/api/anthropic-messages.ts`(1,351 行,按文件顶部导读分 7 段) | 请求翻译、SSE 逐事件解析、tool_use 增量拼装、stop reason 映射、错误重试 |
| D4 | 对照读 `ai/src/api/openai-completions.ts`(只读差异) | tool call delta 累积、`include_usage` 流式用量、compat 开关 |
| D5 | 精抄 `ai/src/providers/faux.ts`(541 行) | 脚本化假 provider:FIFO 响应队列 + delta 模拟;写测试全靠它 |
| D6 | 读 `ai/src/auth/` 概览 + **默写** SSE 解析主循环 | 凭证存取知道即可 |
| D7 | 周总结 | — |

### 第 3 周|agent 包:agent loop(全仓心脏)

**目标**:逐行吃透双层循环。这是整个学习中最重要的一周。

| 天数 | 任务 | 行数 | 重点 |
|---|---|---|---|
| D1 | 精抄 `agent/src/types.ts` | 437 | `AgentTool`/`AgentEvent`(10 种)/`AgentLoopConfig`/`StreamFn` |
| D2-D4 | 精抄 `agent/src/agent-loop.ts`,对照 `ARCHITECTURE.md` 第 5 节 | 792 | 三个细节:工具结果回填即继续、stopReason=length 整批拒执、外层只管 follow-up |
| D5 | 读 `agent/src/agent.ts`(理解即可,选择性抄) | 577 | loop 的 OO 封装:状态、队列、中断 |
| D6 | **默写**:双层循环完整骨架(事件序列 + 结果回填) | — | 本项目最重要的一次默写 |
| D7 | 验证:读并单跑 `agent/test/` 下 agent-loop 测试 | — | — |

### 第 4 周|agent 包 harness:工具 + 压缩 + 会话

| 天数 | 任务 | 行数 | 重点 |
|---|---|---|---|
| D1 | 精抄 `harness/tools/read.ts` + `write.ts` + `tool-context.ts` + `index.ts` | ~230 | 最小完整范式:typebox schema + execute |
| D2 | 精抄 `harness/tools/bash.ts` + `file-mutation-queue.ts` | ~220 | 子进程/超时/截断;写操作串行化 |
| D3 | 精抄 `harness/tools/edit.ts` + `edit-diff.ts` | ~630 | **本周重点**:先精确后模糊匹配;重叠/歧义/无变化三类冲突拒绝 |
| D4 | 精抄 `harness/compaction/compaction.ts` | 880 | 触发时机、切割点选择(不拆散 tool call 对)、摘要生成、上下文重组 |
| D5 | 读 `harness/session/`(session.ts → jsonl-storage.ts → jsonl-repo.ts) | ~900 | append-only jsonl、接口/实现分层 |
| D6 | 读 `harness/agent-harness.ts` 主干 + `skills.ts` + `system-prompt.ts` | ~1,500 | 高层编排;SKILL.md 发现/加载/注入 |
| D7 | 周总结:画 harness 模块关系图 | — | — |

### 第 5 周|coding-agent:装配与落地

| 天数 | 任务 | 重点 |
|---|---|---|
| D1 | 精抄 `cli.ts` + `main.ts`(936 行,按"阶段 0-8"注释) | 参数解析 → 装配 → 模式分发 |
| D2 | 读 `cli/args.ts` + 精抄 `core/agent-session-services.ts`(219 行) | DI 装配清单 |
| D3-D5 | 攻 `core/agent-session.ts`(3,332 行),**只精抄三段**:段 2 事件订阅转发(`_handleAgentEvent`)、段 3 消息发送/排队/中断(`prompt`/队列/`abort`)、段 4 压缩触发(`_checkCompaction`/`_runAutoCompaction`);其余段通读 | 一个 AgentEvent 到屏幕经过几次包装;运行中发消息如何变 follow-up;手动/阈值/溢出三条压缩触发路径 |
| D6 | 精抄 `modes/print-mode.ts`(159 行)+ 读 `core/extensions/` 主干 | 最小可用闭环;扩展钩子挂在事件转发链哪一环 |
| D7 | 验证:print 模式跑一次真实任务,对照 `ARCHITECTURE.md` 第 4 节讲出每级事件 | — |

对比读(不占整天):`coding-agent/src/core/tools/` 对照第 4 周通用版,回答"产品版多了什么"(权限、output-accumulator、truncate 双上限、TUI 渲染)。

### 第 6 周|毕业设计:从零写 mini-pi

**目标**:不看原码,独立写出最小可用 coding agent CLI(300-600 行)。这是检验 5 周成果的唯一标准。

| 天数 | 任务 |
|---|---|
| D1 | 默写统一消息类型 + EventStream(第 1 周成果) |
| D2 | 实现一个 provider(直连 Anthropic 或 OpenAI,SSE 流式解析 + tool call 增量拼装) |
| D3 | 实现双层 agent loop + read/bash/edit 三个工具(schema + execute) |
| D4 | print 模式 CLI:`mini-pi -p "..."` 一次性执行任务,打字机式流式输出 |
| D5 | 加上下文压缩(token 阈值触发 + 摘要)和会话 jsonl 持久化 |
| D6 | 对照原项目找差距:列"mini-pi 缺什么"清单(中断?排队?重试?权限?) |
| D7 | 写毕业总结:整体架构图 + 10 个最值得借鉴的设计决策 |

---

## 四、已加中文注释的源文件清单

| 周次 | 文件(packages/ 下) |
|---|---|
| 第 1 周 | `ai/src/types.ts`、`ai/src/utils/event-stream.ts`、`ai/src/models.ts` |
| 第 2 周 | `ai/src/api/anthropic-messages.ts`、`ai/src/api/openai-completions.ts`、`ai/src/providers/faux.ts` |
| 第 3 周 | `agent/src/types.ts`、`agent/src/agent-loop.ts`(`agent/src/agent.ts` 未注释,学到可让我补) |
| 第 4 周 | `agent/src/harness/` 全部:tools/(10 个)、`compaction/compaction.ts`、`session/`(6 个)、`agent-harness.ts`、`system-prompt.ts`、`skills.ts` |
| 第 5 周 | `coding-agent/src/cli.ts`、`main.ts`、`cli/args.ts`、`core/agent-session-services.ts`、`core/agent-session.ts`、`core/tools/`(15 个)、`modes/print-mode.ts` |
| (可选) | `tui/src/` 6 个文件也已注释,但本计划不要求读(见下) |

## 五、砍掉/降级清单(与原 8 周计划的差异)

| 原内容 | 处理 | 原因 |
|---|---|---|
| 第 7 周 TUI 整周(editor.ts、keys.ts、markdown.ts 深读) | **砍** | 终端 GUI 编程,非 agent 技术。想了解的話花 1 小时读 `tui/src/tui.ts` 顶部注释 + `doRender()` 主干即可 |
| interactive-mode.ts(6,060 行) | **砍** | print-mode(159 行)已覆盖"订阅事件→输出"精髓 |
| server/、storage/、evals/(原 R9) | **砍** | 部署、存储后端、评测均为工程外围 |
| session-manager.ts(1,712 行)、settings-manager.ts、model-registry/ | 降为"知道职责" | pi 产品特有,非 agent 通用知识 |
| extensions/(2,900+ 行) | 降为概读主干 | 插件生态,初期知道钩子挂在哪即可 |
| export-html/、package-manager.ts、utils/ | **砍** | 纯产品功能 |
| ai 包其余 provider(google/bedrock 等) | 砍 | 协议适配是重复模式,精透一个即可 |

省下的约 2 周全部给第 6 周毕业设计和查漏补缺——亲手写出 mini-pi 比多读 5,000 行 UI 代码收获大得多。

## 六、毕业之后:Touchstone(interview/training agent,独立项目,不属于本学习计划)

**项目名:Touchstone**(试金石,《皆大欢喜》角色 + "检验优劣的标准"双关;评估器即产品内核)。

命名资源现状(2026-08 查证):裸名 `touchstone` 在 npm/GitHub/PyPI 均已被占;**npm scope `@touchstone/*` 空闲**(推荐包名方案);GitHub org 可用候选 `touchstone-hq`、`touchstone-labs`、`usetouchstone` 等;域名需另行查询注册商。

学完后启动 Touchstone,作为**独立仓库的真实项目**长期迭代,不放在本学习计划内。

启动时的策略(学完再回头看):

- 以 mini-pi 为内核起点拷入新仓库:消息抽象 + provider 适配 + 双层 loop + 工具范式原样保留。
- 工具替换:bash/edit → 出题/代码沙箱/评分;会话树保留(复盘 = 分支导航,重练 = fork)。
- 新增四块(pi 里没有的,是项目核心难点):评估器(interviewer/evaluator 双 agent 分离)、学习者模型(跨会话弱点追踪,SQLite)、面试流程状态机、题库与 rubric 内容资产。
- 迭代路线:V1 文字版 CLI 面试 → V2 评估分离 + 复盘报告 → V3 学习者模型(变身 training agent)→ V4 可选语音。
- 启动时找我搭仓库骨架即可。

## 七、注意事项

- 不要跑 `npm run build` / 全量 `npm test`;单跑测试用上面的命令。
- 手抄代码放仓库外独立目录(如 `~/mini-pi/`),避免污染本仓库工作区。
- 卡住超过 30 分钟的概念,直接问,不要硬磕。
