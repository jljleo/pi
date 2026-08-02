/**
 * =============================================================================
 * packages/ai/src/types.ts —— 全仓统一消息抽象(本 monorepo 的"普通话")
 * =============================================================================
 *
 * 定位:
 * 本文件定义了整个 pi monorepo 与各 LLM 服务商(OpenAI、Anthropic、Google、
 * Bedrock、Mistral 等)对话时使用的【统一类型层】。packages/ai 下的每个 API 适配器
 * (src/api/*.ts)负责把自家协议翻译成这里的类型;上层的 agent / coding-agent /
 * tui 只认这里的 UserMessage / AssistantMessage / ToolCall / Usage 等,从不直接
 * 接触任何厂商私有格式。换言之,这里是"一次建模、处处复用"的枢纽:新增一个厂商,
 * 只需写一个新适配器把数据映射到这些类型即可。
 *
 * 核心设计理念:
 * 1. 厂商无关:消息、内容块、用量、停止原因全部抽象成与具体 API 无关的形状。
 * 2. 流式优先:AssistantMessageEvent 定义了 start/*_start/*_delta/*_end/done/error
 *    的增量事件协议,UI 可以边生成边渲染。
 * 3. 兼容性下沉:各厂商的怪癖不污染主类型,而是收进 Model.compat 里的
 *    OpenAICompletionsCompat / AnthropicMessagesCompat 等开关集合。
 * 4. 类型安全分层:KnownApi/KnownProvider 枚举已知值,Api/ProviderId 允许任意
 *    字符串扩展(第三方自定义 provider),二者通过条件类型(ApiStreamOptions、
 *    Model.compat)联动,让已知 API 获得精确类型、未知 API 退化为宽松类型。
 *
 * 建议阅读顺序:
 *   (1) KnownApi / ProviderId —— 认识有哪些协议与厂商;
 *   (2) TextContent / ThinkingContent / ImageContent / ToolCall —— 内容块;
 *   (3) UserMessage / AssistantMessage / ToolResultMessage / Message / Context —— 对话模型;
 *   (4) Usage / StopReason —— 计费与终止语义;
 *   (5) StreamOptions / SimpleStreamOptions / StreamFunction —— 调用入口;
 *   (6) AssistantMessageEvent —— 流式事件生命周期(全文重点);
 *   (7) 各 *Compat / Model —— 厂商兼容开关与模型元数据。
 */
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { PiMessagesOptions } from "./api/pi-messages.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

// pi 内置支持的全部 LLM 协议(API 形状)枚举。每种协议对应 src/api/ 下的一个适配器模块,
// 例如 "openai-completions" 对应 openai-completions.ts;上层按此字符串分发到具体实现。
export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

// API 标识的对外类型:已知值(有精确类型推导)与任意自定义字符串的并集。
// `(string & {})` 是 TS 惯用法:既允许传入任意字符串,又不让编辑器丢失 KnownApi 的自动补全。
export type Api = KnownApi | (string & {});

// 图像生成类 API 的已知协议枚举(与文本对话分开建模)。
export type KnownImagesApi = "openrouter-images";

// 图像 API 标识:同样允许自定义扩展。
export type ImagesApi = KnownImagesApi | (string & {});

// 已知的 LLM 服务商(provider)标识枚举。一个 provider 可能提供多种 API 形状,
// provider 决定鉴权方式、计费与 baseUrl,api 决定请求/响应的协议格式。
export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "radius"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
// provider 标识的对外类型:同样允许任意字符串,方便用户接入未内置的厂商。
export type ProviderId = KnownProvider | string;

// 已知的图像生成服务商。
export type KnownImagesProvider = "openrouter";

export type ImagesProviderId = KnownImagesProvider | string;

// 思考(thinking/reasoning)强度等级:模型的"想多久"旋钮。LLM 领域的 thinking 指模型
// 在输出正式答案前先生成一段内部推理链(对用户可隐藏),级别越高推理越充分但越贵越慢。
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
// 模型可选的思考等级:在 ThinkingLevel 之外多一个 "off"(彻底关闭推理)。
export type ModelThinkingLevel = "off" | ThinkingLevel;
// 把 pi 的思考等级映射到厂商/模型私有参数值的对照表:缺省键用 provider 默认,
// null 表示该等级不被此模型支持。由 Model.thinkingLevelMap 使用。
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
// chat_template_kwargs 的取值类型:要么是字面量,要么是 {$var} 占位符——
// 表示"由 pi 在运行时填入当前 thinking 开关/强度",omitWhenOff 表示关闭思考时整个省略该参数。
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort";
			omitWhenOff?: boolean;
	  };

/** Token budgets for each thinking level (token-based providers only) */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// Base options all providers share
// 提示词缓存保留策略:prompt caching 可把重复前缀的计算结果缓存起来省钱省时,
// "none" 不缓存,"short"/"long" 对应不同 TTL(如 Anthropic 5 分钟 vs 1 小时)。
export type CacheRetention = "none" | "short" | "long";

// 流式传输方式:sse = HTTP 服务器推送事件;websocket 及其缓存变体;"auto" 让适配器自选。
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
// fetch 函数类型:允许调用方注入自定义 fetch(加代理、埋点、测试桩)。
export type FetchFunction = typeof globalThis.fetch;
// 会话亲和(session affinity)请求头的格式约定:让同一 session 的请求落到同一后端,
// 提高 prompt cache 命中率;不同网关头名不同,故枚举之。
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

// 一次 HTTP 响应的精简视图,供 onResponse 回调观察状态码与响应头。
export interface ProviderResponse {
	// HTTP 状态码。
	status: number;
	// 响应头(已拍平为字符串字典)。
	headers: Record<string, string>;
}

// 发起一次 LLM 流式调用时可传的全部通用选项。各 provider 适配器读取自己认识的字段、
// 忽略其余;具体 API 还有额外选项时通过 ApiStreamOptions 扩展。
export interface StreamOptions {
	// 采样温度:越高越发散。LLM 通用采样参数。
	temperature?: number;
	// 最大输出 token 数上限。
	maxTokens?: number;
	// 中止信号:用于用户取消请求。
	signal?: AbortSignal;
	// API 密钥;不显式传时由 provider 从环境变量解析。
	apiKey?: string;
	/**
	 * Optional fetch implementation for provider HTTP requests.
	 * Defaults to `globalThis.fetch`. Provider adapters that cannot inject a custom implementation may reject it.
	 * This does not affect WebSocket transports.
	 */
	fetch?: FetchFunction;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport?: Transport;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 */
	cacheRetention?: CacheRetention;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId?: string;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; caller values override default headers.
	 * On AWS Bedrock these are injected via a Smithy `build`-step middleware so
	 * they are covered by SigV4 signing; reserved headers (`x-amz-*`,
	 * `authorization`, `host`) are silently ignored to preserve SigV4 / bearer auth.
	 * A null value suppresses a provider/API default header with the same name.
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 */
	timeoutMs?: number;
	/**
	 * WebSocket connect timeout in milliseconds for providers that support
	 * WebSocket transports. This covers the connection/open handshake only;
	 * stream idleness after connection uses timeoutMs.
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as regional settings, endpoint placeholders, and
	 * proxy variables.
	 */
	env?: ProviderEnv;
}

// 宽松的 provider 流式选项:通用选项 + 任意厂商私有扩展字段。
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * Maps known APIs to their full provider-specific stream option types.
 * Type-only imports from API implementation modules are erased at emit, so
 * this is tree-shake safe.
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"pi-messages": PiMessagesOptions;
}

/**
 * Full stream options for an API. Known APIs resolve to their concrete option
 * type; custom API strings fall back to the generic shape.
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * The uniform stream contract of an API implementation module: every module
 * under `src/api/` exports exactly `stream` and `streamSimple`, so the module
 * itself satisfies this interface. Lazy wrappers (`lazyApi()`) and provider
 * factories pass these around as values. This is the untyped dispatch shape;
 * per-API option typing lives on the implementation modules themselves and on
 * `Provider.stream()` via `ApiStreamOptions`.
 */
// 每个 src/api/ 文本适配器模块的统一出口形状:恰好导出 stream 与 streamSimple 两个函数,
// 因此模块对象本身就满足此接口,可被 lazyApi() 惰性包装、被 provider 工厂当值传递。
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * The uniform contract of an image-generation API implementation module:
 * every image API module under `src/api/` exports exactly `generateImages`,
 * so the module itself satisfies this interface. Lazy wrappers and image
 * provider factories pass these around as values.
 */
// 图像生成适配器模块的统一出口形状:恰好导出一个 generateImages 函数。
export interface ProviderImages {
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

// 图像生成选项:与 StreamOptions 平行的简化版(图像生成本身非流式,一次请求一张结果)。
export interface ImagesOptions {
	// 中止信号。
	signal?: AbortSignal;
	// API 密钥。
	apiKey?: string;
	/** Optional fetch implementation for provider HTTP requests. Defaults to `globalThis.fetch`. */
	fetch?: FetchFunction;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as endpoint placeholders and proxy variables.
	 */
	env?: ProviderEnv;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: ImagesModel<ImagesApi>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	onResponse?: (response: ProviderResponse, model: ImagesModel<ImagesApi>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; can override default headers.
	 * A null value suppresses a provider/API default header with the same name.
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 */
	metadata?: Record<string, unknown>;
}

// 宽松的图像生成选项:通用选项 + 厂商私有扩展字段。
export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
// 简化版流式选项:在通用选项之上增加"思考强度"这一高层开关,供 streamSimple()/completeSimple()
// 这类一行式便捷 API 使用,免去调用方拼装厂商私有的 reasoning 参数。
export interface SimpleStreamOptions extends StreamOptions {
	// 期望的推理强度;适配器负责映射成厂商私有参数。
	reasoning?: ThinkingLevel;
	/** Custom token budgets for thinking levels (token-based providers only) */
	// 按思考等级自定义推理 token 预算(仅对按 token 计量的 provider 生效)。
	thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Must return an AssistantMessageEventStream.
// - Once invoked, request/model/runtime failures should be encoded in the
//   returned stream, not thrown.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
// 统一的流式调用函数签名:每个 API 适配器最终都暴露成这个形状,
// 上层(agent 循环)只面向它编程。契约要点:失败不抛出,而是通过返回的事件流里的
// error 事件 + stopReason "error"/"aborted" 上报。
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

// 统一的图像生成函数签名(非流式,一次性返回结果)。
export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

// 文本块签名的结构化版本(v1):OpenAI Responses 用它在多轮对话中回引之前的消息项,
// phase 区分"解说/工具前言"与"最终答案"。以 JSON 字符串形式存进 TextContent.textSignature。
export interface TextSignatureV1 {
	// 签名格式版本号。
	v: 1;
	// 上游返回的消息项 id。
	id: string;
	// 该文本块所处阶段。
	phase?: "commentary" | "final_answer";
}

// 内容块:纯文本。消息体是内容块数组而非单字符串,因为现代 LLM 响应混合文本/思考/工具调用,
// 用户输入也可混合文本与图片。
export interface TextContent {
	type: "text";
	// 文本本体。
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

// 内容块:模型推理链(thinking/reasoning)。业务上对应"模型正在思考"的那部分输出,
// 通常在 UI 里折叠显示;多轮对话时按原样回传给 API 以保持推理连续性。
export interface ThinkingContent {
	type: "thinking";
	// 推理文本本体。
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	redacted?: boolean;
}

// 内容块:图片(base64 内联)。用于多模态输入(用户贴图)与图像生成输出。
export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
}

// 内容块:工具调用(tool call / function calling)。LLM 不直接执行动作,而是输出
// "请调用名为 name 的工具、参数为 arguments"的结构化请求;宿主程序执行后用
// ToolResultMessage 把结果回喂给模型,id 用于把结果和调用对上号。
export interface ToolCall {
	type: "toolCall";
	// 本次调用的唯一 id(由模型生成),供 ToolResultMessage.toolCallId 回指。
	id: string;
	// 工具名,对应 Context.tools 里某个 Tool.name。
	name: string;
	// 调用参数(JSON 对象)。
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
}

// 单次请求的 token 用量与费用统计。LLM 按 token 计费,这里把各厂商口径统一成
// input/output/cacheRead/cacheWrite 四类:cacheRead 是命中提示词缓存省下的输入,
// cacheWrite 是写入缓存的开销。UI 用它显示花费,agent 用它做预算控制。
export interface Usage {
	// 输入(提示词)token 数。
	input: number;
	// 输出(补全)token 数。
	output: number;
	// 从缓存读取的输入 token 数(便宜)。
	cacheRead: number;
	// 写入缓存的 token 数(略贵于普通输入)。
	cacheWrite: number;
	/** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
	cacheWrite1h?: number;
	/**
	 * Reasoning/thinking tokens, when the provider reports them. This is a subset of
	 * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
	 * providers that expose a reasoning breakdown; left undefined by providers that don't.
	 */
	reasoning?: number;
	// 上游报告的总 token 数(一般 ≈ input+output,以厂商口径为准)。
	totalTokens: number;
	// 按 Model.cost 费率折算出的美元费用明细。
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

// 停止原因:模型本轮输出为何结束。业务含义:
//   "pending" 流尚未结束(中间态);"stop" 正常说完;"length" 撞 maxTokens 上限被截断;
//   "toolUse" 模型想调工具(需要宿主执行后继续);"error" 出错;"aborted" 被用户取消。
// agent 循环依据它决定是渲染答案、执行工具还是报错。
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

// 用户消息:对话历史里 role 为 "user" 的一轮。content 支持纯文本或文本+图片混合的内容块数组。
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

// 助手消息:模型一轮完整输出的统一表示,也是流式协议里 partial/done 事件携带的对象。
// 它是全仓最核心的数据结构——适配器产出它、agent 消费并追加进历史、TUI 渲染它。
export interface AssistantMessage {
	role: "assistant";
	// 内容块数组:一段回复可能含多段文本、多段 thinking、多个 toolCall,按生成顺序排列。
	content: (TextContent | ThinkingContent | ToolCall)[];
	// 产生此消息的 API 协议与厂商(用于回放时走对的适配器、以及计费口径)。
	api: Api;
	provider: ProviderId;
	// 请求时指定的模型 id。
	model: string;
	responseModel?: string; // Concrete `chunk.model` when different from the requested `model` (e.g. OpenRouter `auto` -> `anthropic/...`)
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	// token 用量与费用。
	usage: Usage;
	// 本轮停止原因。
	stopReason: StopReason;
	// stopReason 为 error/aborted 时的人类可读错误描述。
	errorMessage?: string;
	// 厂商原始的 finish_reason(调试用,未归一化)。
	rawStopReason?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

// 工具结果消息:宿主执行完模型请求的 toolCall 后,把结果包装成此消息追加回对话历史,
// 模型下一轮据此继续。TDetails 泛型供工具附带结构化详情(如 diff、行号)给 UI 用,
// 但不回传给模型。
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	// 回指触发本结果的 ToolCall.id。
	toolCallId: string;
	// 工具名(冗余于 toolCallId,方便序列化与渲染)。
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	// 仅供 UI/宿主使用的结构化详情,不进 LLM 上下文。
	details?: TDetails;
	/** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
	usage?: Usage;
	/**
	 * Names from `Context.tools` that became available after this result.
	 * Providers with native deferred tool loading use this as the load point;
	 * other providers ignore it and use `Context.tools` normally.
	 */
	addedToolNames?: string[];
	// 本次工具执行是否以失败告终(模型会据此决定重试/换方案)。
	isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

// 对话历史中的消息:三种角色的判别联合(按 role 字段区分)。
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// 图像生成的输入/输出内容块(文生图、图生图)。
export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;

// 图像生成请求上下文。
export interface ImagesContext {
	input: ImagesInputContent[];
}

// 图像生成的停止原因(无 toolUse/length,因为不是对话补全)。
export type ImagesStopReason = "stop" | "error" | "aborted";

// 一次图像生成的完整结果,与 AssistantMessage 平行。
export interface AssistantImages {
	api: ImagesApi;
	provider: ImagesProviderId;
	model: string;
	// 生成的内容块(图片和/或文字说明)。
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

import type { TSchema } from "typebox";

/** OpenAI grammar variants for constrained sampling. */
// 受约束采样(constrained sampling)的语法格式枚举:强制模型输出必须符合给定语法/正则,
// 用于要求严格格式输出(如代码、DSL)的场景。
export type GrammarFormat = "openai_lark" | "openai_regex";

// 同一语法按不同格式的多份编码。
export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

/**
 * Optional provider-side constrained sampling configs for a tool.
 *
 * The `json_schema` value roughly maps to the concept of `strict` in APIs which is
 * implemented as json-schema constrained sampling by APIs. Grammar variants let
 * callers provide provider-specific encodings of the same intended language.
 */
export type ConstrainedSamplingConfig =
	| {
			type: "json_schema";
			strict: "prefer" | "require";
	  }
	| {
			type: "grammar";
			variants: GrammarVariants;
	  };

// 工具定义:告诉模型"你可以调什么"。TParameters 用 typebox 的 JSON Schema 描述参数形状,
// 既用于运行时校验,也直接序列化进 API 请求。
export interface Tool<TParameters extends TSchema = TSchema> {
	// 工具名,模型在 ToolCall.name 里引用它。
	name: string;
	// 给模型看的自然语言说明(影响它何时、如何调用)。
	description: string;
	// 参数的 JSON Schema。
	parameters: TParameters;
	// 可选的受约束采样配置,false 表示显式禁用。
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

// 一次 LLM 调用的完整输入上下文:系统提示 + 对话历史 + 可用工具清单。
// 上层 agent 每轮拼装好 Context 交给 StreamFunction。
export interface Context {
	// 系统提示词(角色设定、行为准则)。
	systemPrompt?: string;
	// 到目前为止的对话历史。
	messages: Message[];
	// 本轮可用的工具列表。
	tools?: Tool[];
}

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
// ============================================================================
// 流式事件协议:AssistantMessageEventStream 发出的事件联合(共 12 种)。
// ============================================================================
// 生命周期是对称的两层结构,消费方(UI、agent)按此状态机更新渲染:
//
//   外层(整条消息):  start ──(若干内容块事件)──> done | error
//   内层(每个内容块): xxx_start ── xxx_delta* ── xxx_end
//
// - start:消息开始,partial 是一个几乎为空的 AssistantMessage 骨架(已填好
//   api/provider/model,content 为空数组,stopReason 为 "pending")。
// - text_start / thinking_start / toolcall_start:第 contentIndex 个内容块开始,
//   partial.content 里相应位置出现对应空块。三类块各有独立的一组事件。
// - text_delta / thinking_delta:增量文本流(打字机效果的数据来源),delta 是新增片段,
//   partial 始终是累加后的最新快照。
// - toolcall_delta:工具调用参数 JSON 的增量片段(参数本身也是流式生成的字符串)。
// - text_end / thinking_end / toolcall_end:该块完成,携带最终完整内容(content 或 toolCall)。
// - done:整条消息成功结束,reason 只有三种正常结局(stop/length/toolUse),
//   message 是最终完整 AssistantMessage。
// - error:整条消息失败或被取消,reason 只有 aborted/error 两种,error 字段同样是
//   一个完整的 AssistantMessage(stopReason 为 error/aborted 并带 errorMessage)。
//
// 关键约定:除 done/error 外每个事件都带 partial(当前最新快照),因此消费方可以
// 不自己拼 delta、直接用 partial 覆盖渲染;而 delta 字段留给需要精细动画的场景。
// 每个流要么以 done 要么以 error 收尾,二者互斥且恰好一次。
export type AssistantMessageEvent =
	// 消息开始:外层生命周期起点。
	| { type: "start"; partial: AssistantMessage }
	// 文本块开始。
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	// 文本块增量。
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	// 文本块完成,content 为该块完整文本。
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	// 推理(thinking)块开始。
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	// 推理块增量。
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	// 推理块完成。
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	// 工具调用块开始。
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	// 工具调用参数 JSON 的增量片段。
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	// 工具调用块完成,toolCall 为组装完毕的完整调用。
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	// 整条消息正常结束(三种正常停止原因之一)。
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	// 整条消息异常结束(出错或被用户中止)。
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * Compatibility settings for OpenAI-compatible completions APIs.
 * Use this to override URL-based auto-detection for custom providers.
 */
// OpenAI completions 系兼容开关集合。大量第三方厂商自称"OpenAI 兼容"但各有偏差
// (字段名不同、不支持某参数等),这些开关覆盖基于 baseUrl 的自动探测结果,
// 让适配器按厂商实际能力调整请求格式。由 OpenAICompletionsOptions.compat 消费。
export interface OpenAICompletionsCompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	// 是否支持 store 字段(OpenAI 的对话存储)。
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	// 是否支持 developer 角色(否则用传统 system)。
	supportsDeveloperRole?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	// 是否支持 reasoning_effort 推理强度参数。
	supportsReasoningEffort?: boolean;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	// 流式响应里能否索取 token 用量统计。
	supportsUsageInStreaming?: boolean;
	/** Whether streamed responses include `finish_reason`. When false, pi infers `stop` or `toolUse` when the stream ends. Default: true. */
	// 流式响应是否带 finish_reason;不带时 pi 在流结束时自行推断 stop/toolUse。
	supportsFinishReason?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	// 最大 token 数用哪个字段名(新旧两代 OpenAI 参数)。
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	// 工具结果消息是否必须带 name 字段。
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	// 工具结果之后、下一条用户消息之前是否必须夹一条 assistant 消息(某些厂商的怪癖)。
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	// 是否必须把 thinking 块改写成 <thinking> 标签包围的纯文本(不支持原生推理块的厂商)。
	requiresThinkingAsText?: boolean;
	/** Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. */
	// 开启推理时,回放的 assistant 消息是否必须带空 reasoning_content 字段(deepseek 系要求)。
	requiresReasoningContentOnAssistantMessages?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "deepseek" uses thinking: { type } plus reasoning_effort when supported, "together" uses reasoning: { enabled } plus reasoning_effort when supported, "zai" uses thinking: { type }, "qwen" uses top-level enable_thinking: boolean, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking: string, and "ant-ling" uses reasoning: { effort } only when the mapped effort is non-null. Default: "openai". */
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling";
	/** Kwargs to send as `chat_template_kwargs` when `thinkingFormat` is `chat-template`. Use `{ "$var": "thinking.enabled" }` or `{ "$var": "thinking.effort" }` for pi-controlled thinking values. */
	// thinkingFormat 为 chat-template 时发送的 chat_template_kwargs,可用 $var 占位符由 pi 注入。
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	/** OpenRouter-compatible routing preferences sent as the `provider` request field. */
	// OpenRouter 路由偏好(选择上游厂商的策略)。
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	// Vercel AI Gateway 路由偏好。
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Whether z.ai supports top-level `tool_stream: true` for streaming tool call deltas. Default: false. */
	// z.ai 是否支持 tool_stream 流式工具调用参数。
	zaiToolStream?: boolean;
	/** Whether the provider supports OpenAI custom tools with Lark/regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. Default: false; the generated model catalog enables it for capable models. */
	// 是否支持 Lark/regex 语法的 OpenAI 自定义工具;不支持则退化为普通 function 工具。
	supportsOpenAIGrammarTools?: boolean;
	/** Whether the provider supports the `strict` field in tool definitions. Default: true. */
	// 工具定义是否支持 strict 严格 JSON Schema 模式。
	supportsStrictMode?: boolean;
	/** Cache control convention for prompt caching. "anthropic" applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content. */
	// 提示词缓存标记的写法约定(目前仅 Anthropic 风格 cache_control)。
	cacheControlFormat?: "anthropic";
	/** Whether to send session-affinity data from `options.sessionId`. Default: false. */
	// 是否发送会话亲和请求头。
	sendSessionAffinityHeaders?: boolean;
	/** Provider-specific deferred tool serialization mode. */
	// 延迟加载工具的序列化方式(厂商私有,如 kimi)。
	deferredToolsMode?: "kimi";
	/** Session-affinity header format: `openai` sends `session_id`, `x-client-request-id`, and `x-session-affinity`; `openai-nosession` sends `x-client-request-id` and `x-session-affinity`; `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param, which is governed by cache retention. Default: auto-detected. */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** Whether the provider supports long prompt cache retention (`prompt_cache_retention: "24h"` or Anthropic-style `cache_control.ttl: "1h"`, depending on format). Default: true. */
	supportsLongCacheRetention?: boolean;
}

/** Compatibility settings for OpenAI Responses APIs. */
// OpenAI Responses 系(新世代 OpenAI API)的兼容开关集合,思路同 OpenAICompletionsCompat。
export interface OpenAIResponsesCompat {
	/** Whether the provider supports the `developer` role (vs `system`). Default: true. */
	// 是否支持 developer 角色。
	supportsDeveloperRole?: boolean;
	/** Session-affinity header format: `openai` sends `session_id` and `x-client-request-id`; `openai-nosession` sends `x-client-request-id`; `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param, which is governed by cache retention. Default: auto-detected. */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** Whether the provider supports `prompt_cache_retention: "24h"`. Default: true. */
	supportsLongCacheRetention?: boolean;
	/** Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly. */
	supportsStrictMode?: boolean;
	/** Whether to emit OpenAI custom tools with Lark/regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. Default: false; the generated model catalog enables it for capable models. */
	supportsOpenAIGrammarTools?: boolean;
	/** Whether the model supports client-executed tool search for deferred tools. Default: false. */
	supportsToolSearch?: boolean;
	/** Whether the model accepts `prompt_cache_options` (OpenAI GPT-5.6+ explicit prompt caching). Older OpenAI models reject the parameter. Default: false. */
	supportsExplicitPromptCacheMode?: boolean;
}

/** Compatibility settings for Anthropic Messages-compatible APIs. */
// Anthropic Messages 系的兼容开关集合:处理各家"Claude 兼容"实现的差异
// (缓存标记、工具流式、自适应思考、延迟工具等)。
export interface AnthropicMessagesCompat {
	/**
	 * Whether the provider accepts per-tool `eager_input_streaming`.
	 * When false, the Anthropic provider omits `tools[].eager_input_streaming`
	 * and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header
	 * for tool-enabled requests.
	 * Default: true.
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
	supportsLongCacheRetention?: boolean;
	/**
	 * Whether to send the `x-session-affinity` header from `options.sessionId`
	 * when caching is enabled. Required for providers like Fireworks that use
	 * session affinity for prompt cache routing (requests to the same replica
	 * maximize cache hits).
	 * Default: false.
	 */
	sendSessionAffinityHeaders?: boolean;
	/**
	 * Whether the provider supports Anthropic-style `cache_control` markers on
	 * tool definitions. When false, `cache_control` is omitted from tool params.
	 * Some Anthropic-compatible providers (e.g., Fireworks) do not support this
	 * field on tools and may reject or ignore it.
	 * Default: true.
	 */
	supportsCacheControlOnTools?: boolean;
	/**
	 * Whether the model accepts the Anthropic `temperature` request field.
	 * Claude Opus 4.7+ rejects non-default temperature values.
	 * Default: true.
	 */
	supportsTemperature?: boolean;
	/**
	 * Whether to force adaptive thinking (`thinking.type: "adaptive"` plus
	 * `output_config.effort`) regardless of the model id. Built-in models that
	 * require adaptive thinking set this in generated metadata. Custom
	 * Anthropic-compatible providers can set this to `true` for any model whose
	 * upstream requires the adaptive format. Set to `false` to
	 * opt out on overridden built-in models.
	 * Default: false.
	 */
	forceAdaptiveThinking?: boolean;
	/** Whether to replay empty thinking signatures as `signature: ""` instead of converting thinking to text. Default: false. */
	allowEmptySignature?: boolean;
	/** Whether the provider supports Anthropic strict tool schemas. Default: false; generated Anthropic models enable it explicitly. */
	supportsStrictTools?: boolean;
	/**
	 * Whether the provider supports deferred tools loaded by `tool_reference`
	 * blocks in tool results. Default: true for first-party Anthropic models
	 * except Haiku and models older than Claude 4.5; false for other providers.
	 */
	supportsToolReferences?: boolean;
}

/** Compatibility settings for Amazon Bedrock models. */
// Amazon Bedrock 系的兼容开关集合。
export interface BedrockCompat {
	/** Whether the model supports Bedrock strict tool schemas. Default: false. */
	// 是否支持 Bedrock 严格工具 Schema。
	supportsStrictMode?: boolean;
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * Sent as the `provider` field in the OpenRouter API request body.
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
// OpenRouter 的上游路由偏好:OpenRouter 是聚合网关,同一模型背后有多个上游厂商,
// 这里控制"允许谁、优先谁、跳过谁、按价格/吞吐/时延怎么排"。
export interface OpenRouterRouting {
	/** Whether to allow backup providers to serve requests. Default: true. */
	allow_fallbacks?: boolean;
	/** Whether to filter providers to only those that support all parameters in the request. Default: false. */
	require_parameters?: boolean;
	/** Data collection setting. "allow" (default): allow providers that may store/train on data. "deny": only use providers that don't collect user data. */
	data_collection?: "deny" | "allow";
	/** Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. */
	zdr?: boolean;
	/** Whether to restrict routing to only models that allow text distillation. */
	enforce_distillable_text?: boolean;
	/** An ordered list of provider names/slugs to try in sequence, falling back to the next if unavailable. */
	order?: string[];
	/** List of provider names/slugs to exclusively allow for this request. */
	only?: string[];
	/** List of provider names/slugs to skip for this request. */
	ignore?: string[];
	/** A list of quantization levels to filter providers by (e.g., ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]). */
	quantizations?: string[];
	/** Sorting strategy. Can be a string (e.g., "price", "throughput", "latency") or an object with `by` and `partition`. */
	sort?:
		| string
		| {
				/** The sorting metric: "price", "throughput", "latency". */
				by?: string;
				/** Partitioning strategy: "model" (default) or "none". */
				partition?: string | null;
		  };
	/** Maximum price per million tokens (USD). */
	max_price?: {
		/** Price per million prompt tokens. */
		prompt?: number | string;
		/** Price per million completion tokens. */
		completion?: number | string;
		/** Price per image. */
		image?: number | string;
		/** Price per audio unit. */
		audio?: number | string;
		/** Price per request. */
		request?: number | string;
	};
	/** Preferred minimum throughput (tokens/second). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
	preferred_min_throughput?:
		| number
		| {
				/** Minimum tokens/second at the 50th percentile. */
				p50?: number;
				/** Minimum tokens/second at the 75th percentile. */
				p75?: number;
				/** Minimum tokens/second at the 90th percentile. */
				p90?: number;
				/** Minimum tokens/second at the 99th percentile. */
				p99?: number;
		  };
	/** Preferred maximum latency (seconds). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
	preferred_max_latency?:
		| number
		| {
				/** Maximum latency in seconds at the 50th percentile. */
				p50?: number;
				/** Maximum latency in seconds at the 75th percentile. */
				p75?: number;
				/** Maximum latency in seconds at the 90th percentile. */
				p90?: number;
				/** Maximum latency in seconds at the 99th percentile. */
				p99?: number;
		  };
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
// Vercel AI Gateway 的路由偏好:指定走哪些上游厂商及其尝试顺序。
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

// 每百万 token 的美元费率表:Usage.cost 折算的依据。
export interface ModelCostRates {
	input: number; // $/million tokens
	output: number; // $/million tokens
	cacheRead: number; // $/million tokens
	cacheWrite: number; // $/million tokens
}

// 费率阶梯:当请求总输入 token 数超过 inputTokensAbove 时启用本档费率
// (部分模型超长上下文加价,如 Claude 长上下文档)。
export interface ModelCostTier extends ModelCostRates {
	/** Use this tier for requests whose total input usage exceeds this token count. */
	inputTokensAbove: number;
}

// 模型计费信息:基础费率 + 可选的超长输入阶梯价。
export interface ModelCost extends ModelCostRates {
	/** Request-wide pricing tiers. The highest matching input threshold applies to the full request. */
	tiers?: ModelCostTier[];
}

// Model interface for the unified model system
// 统一模型描述:pi 选型、路由、计费、能力判断都围绕它。TApi 泛型把模型绑定到
// 具体 API 协议,从而让 compat 字段获得与协议匹配的精确类型(见下方条件类型)。
// 内置模型清单位于 models.generated.ts(由脚本生成,勿手改);用户也可自定义 Model。
export interface Model<TApi extends Api> {
	// 模型 id(发给 API 的标识,如 "gpt-5"、"claude-opus-4-1")。
	id: string;
	// 人类可读名称(UI 展示用)。
	name: string;
	// 该模型走哪种 API 协议。
	api: TApi;
	// 提供该模型的厂商。
	provider: ProviderId;
	// API 端点;也用于 compat 能力的自动探测。
	baseUrl: string;
	// 是否具备推理(thinking)能力。
	reasoning: boolean;
	/**
	 * Maps pi thinking levels to provider/model-specific values.
	 * Missing keys use provider defaults. null marks a level as unsupported.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	// 支持的输入模态(纯文本或文本+图片)。
	input: ("text" | "image")[];
	// 计费费率。
	cost: ModelCost;
	// 上下文窗口大小(token 数):对话历史+输出不能超过它。
	contextWindow: number;
	// 单次最大输出 token 数。
	maxTokens: number;
	// 该模型固定附加的请求头。
	headers?: Record<string, string>;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	// 厂商兼容开关;条件类型按 api 精确到对应 Compat 接口,未知 API 为 never(不可设)。
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: never;
}

// 图像生成模型描述:复用 Model 的大部分字段,去掉对话特有的字段
// (推理、上下文窗口、maxTokens、compat),换成输出模态声明。
export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	api: TApi;
	provider: ImagesProviderId;
	// 支持的输出模态。
	output: ("text" | "image")[];
}
