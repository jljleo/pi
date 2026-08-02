/*
 * 【中文导读】本文件是 ai 包 provider(厂商)抽象的中枢。
 *
 * 它定义了三层核心概念:
 * - Provider:一个具体的大模型厂商运行时单元(身份元数据、鉴权方式、模型清单、流式请求行为)。
 * - Models / ModelsImpl:所有 provider 的运行时集合,负责鉴权解析、凭证存储、模型清单刷新,
 *   并把每个请求委托给模型所属的 provider。
 * - createProvider():把"鉴权 + 模型清单 + api 协议实现"组装成一个 Provider;
 *   内置的 providers/*.ts 工厂函数和 models.json 自定义厂商都通过它创建。
 *
 * 与其他文件的关系(文字描述):
 * - types.ts:定义本文件用到的全部基础类型——Api(协议标识联合类型)、Model(模型元数据)、
 *   StreamOptions / SimpleStreamOptions / ApiStreamOptions(各级流式选项)、ProviderStreams
 *   (单个协议实现的 stream/streamSimple 函数对)、Usage 等。本文件只做组合,不定义协议细节。
 * - api/*.ts:每个文件实现一种"协议"(如 anthropic-messages、openai-responses、
 *   openai-completions 等),导出符合 ProviderStreams 形状的 stream/streamSimple。
 *   api/lazy.ts 提供 lazyStream,把异步鉴权延迟到流真正开始被消费时才执行;
 *   本文件所有 stream 路径都经过它。
 * - providers/*.ts:每个内置厂商一个工厂(如 anthropicProvider()),填充 CreateProviderOptions
 *   (静态模型清单、鉴权语义、指向 api/*.ts 的协议实现),再调用本文件的 createProvider()。
 * - auth/*.ts:鉴权子系统。resolve.ts 的 resolveProviderAuth 被本文件的 getAuth/applyAuth 调用,
 *   把"存储的凭证 + 环境变量 + 交互式登录"解析成一次请求可用的 AuthResult;
 *   credential-store.ts 负责凭证持久化;context.ts 提供默认 AuthContext(终端交互等宿主能力)。
 * - models-store.ts:动态模型清单的持久化存储(刷新结果的读写缓存)。
 *
 * 建议阅读顺序:
 * 1. 先看 types.ts 的 Model / Api / StreamOptions / ProviderStreams,理解数据形状;
 * 2. 回到本文件,读 Provider 与 Models 两个接口,理解职责划分;
 * 3. 读 createProvider() 的 dispatch 逻辑,理解"按 model.api 选择 api/ 下协议实现"的机制;
 * 4. 挑一个 providers/*.ts 工厂 + 对应的 api/*.ts 协议实现,顺着一个 stream 请求走一遍;
 * 5. 最后看 auth/resolve.ts,理解鉴权如何被解析并注入请求头。
 */
import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	ProviderAuth,
} from "./auth/types.ts";
import { InMemoryModelsStore, type ModelsStore, type ProviderModelsStore } from "./models-store.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "./types.ts";

export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";

// 传给 provider.refreshModels() 的上下文:一次"刷新模型清单"操作所需的全部输入。
// 是什么:有效凭证 + 该 provider 专属的持久化存储 + 网络开关/强制刷新/取消信号。
// 为什么:刷新可能离线启动(只恢复缓存),也可能联网拉取,调用方需要能控制并中途取消。
// 谁在调用:ModelsImpl.refresh() 为每个动态 provider 构造它;createProvider() 内部消费它。
export interface RefreshModelsContext {
	/** Effective configured credential. OAuth credentials are refreshed before network access. */
	credential?: Credential;
	/** Persistent model storage scoped to this provider ID. */
	store: ProviderModelsStore;
	/** False during offline/cache-only initialization. */
	allowNetwork: boolean;
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	force?: boolean;
	signal?: AbortSignal;
}

// Models.refresh() 的入参选项:是否允许联网、是否绕过新鲜度检查强制拉取、取消信号。
export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	force?: boolean;
	signal?: AbortSignal;
}

// Models.refresh() 的返回值:整体是否被取消,以及按 provider id 索引的错误表(错误被收集而非抛出)。
export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}

// 额外的请求头变换钩子:在鉴权合并出最终 headers 之后、发给协议实现之前,允许调用方再改一次。
// 只存在于 Models 层(协议实现层不认识它),在 applyAuth() 中最后被应用。
export interface ModelsStreamTransforms {
	/** Transform fully assembled model/auth/request headers before provider dispatch. */
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}

// Models 层 stream 用的选项 = 该协议(api/*.ts)的特定选项 + 上面的请求头变换钩子。
export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsStreamTransforms;
// Models 层 streamSimple 用的选项 = 协议无关的简化选项 + 请求头变换钩子。
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsStreamTransforms;

/**
 * A provider is the concrete runtime unit. It owns id/name/base metadata,
 * auth methods, model listing, and stream behavior.
 *
 * `TApi` lets concrete provider factories declare which APIs their models
 * use (e.g. `openaiProvider(): Provider<"openai-responses" | "openai-completions">`),
 * giving typed model lists to direct factory users. Inside a `Models`
 * collection providers are held as `Provider<Api>`.
 */
// 【核心接口】Provider:一个具体大模型厂商的运行时单元。
// 是什么:厂商身份(id/name/baseUrl/headers)+ 鉴权方式(auth)+ 模型清单(getModels/refreshModels)
//        + 流式请求能力(stream/streamSimple)。
// 为什么:把"不同厂商、不同协议"的差异收敛到统一接口,上层(agent、coding-agent)只面向 Provider 编程。
// 谁在调用:providers/*.ts 的工厂通过 createProvider() 创建它;ModelsImpl 持有并调用它的各方法。
// 泛型 TApi 在类型层面声明该厂商的模型使用哪些协议;放进 Models 集合时统一退化为 Provider<Api>。
export interface Provider<TApi extends Api = Api> {
	// 厂商唯一标识(如 "anthropic"、"openai"),同时作为凭证存储和模型存储的 key;name 是显示名。
	readonly id: string;
	readonly name: string;

	// 可选:覆盖协议默认的基础 URL(代理、自建端点)与附加请求头。
	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;

	// 鉴权方式(必填):apiKey 与 oauth 至少其一;即使无 key 的本地服务也要提供 apiKey 语义,
	// 用 resolve() 报告"是否已配置",从而统一上层的配置检查逻辑。
	/**
	 * Required: at least one of `apiKey`/`oauth`. Every provider has auth
	 * semantics — even providers with only ambient credentials (env vars, AWS
	 * profiles, ADC files) and keyless local servers provide `apiKey` auth
	 * whose `resolve()` reports whether the provider is configured.
	 * `Models.getAuth()` returns undefined when the provider is unconfigured.
	 */
	readonly auth: ProviderAuth;

	// 同步返回当前已知模型清单:静态厂商返回目录,动态厂商返回上次刷新后的清单(首次刷新前为空)。
	// 不允许抛错——Models 层会把抛错的实现当作"没有模型"。
	/**
	 * Current known models, sync. Static providers return their catalog;
	 * dynamic providers return the list as of the last `refreshModels()`
	 * (empty before the first). Must not throw; `Models` treats a throwing
	 * implementation as having no models.
	 */
	getModels(): readonly Model<TApi>[];

	// 仅动态厂商实现:先恢复持久化的缓存清单,再(允许联网时)拉取新清单;失败必须保留旧清单。
	/**
	 * Dynamic providers only: restore the provider-scoped stored catalog and optionally fetch
	 * a newer list using the effective credential. Implementations must retain their previous
	 * list on failure and honor the shared abort signal for network requests.
	 */
	refreshModels?(context: RefreshModelsContext): Promise<void>;

	// 可选的厂商策略:按当前凭证过滤可用模型(如某些 key 只能用部分模型),由 Models.getAvailable() 应用。
	/**
	 * Optional provider policy for credential-specific model availability.
	 * `getModels()` remains the complete synchronous catalog; `Models.getAvailable()`
	 * applies this filter after confirming that provider auth is configured.
	 */
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];

	// 【stream:协议特定选项路径】用该模型所属协议(api/*.ts)的完整选项发起流式请求。
	// 泛型 T 让 options 精确匹配 model.api 对应的 ApiStreamOptions(如 anthropic 的 thinking 配置)。
	// 调用方:ModelsImpl.stream() 鉴权后委托到这里;需要协议全部能力的调用方用它。
	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	// 【streamSimple:协议无关简化路径】只接受跨协议通用的简化选项 SimpleStreamOptions
	// (温度、maxTokens、思考等级等),由协议实现内部翻译成各自的原生参数。
	// 与 stream 的区别:stream 暴露协议特定选项(强类型、能力全),streamSimple 用统一选项换可移植性。
	// 调用方:ModelsImpl.streamSimple();写"一套代码跑多家模型"的上层用它。
	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * Runtime collection of providers plus auth application and stream
 * convenience. Providers own stream behavior; `Models` resolves auth and
 * delegates each request to the provider that owns the model.
 */
// 【核心接口】Models:所有 provider 的运行时集合 + 鉴权应用 + 流式请求入口。
// 是什么:provider 注册表(getProviders/getProvider)、模型查询(getModels/getModel)、动态清单刷新(refresh)、
//        鉴权生命周期(checkAuth/getAuth/login/logout)、请求入口(stream/complete 及 Simple 变体)。
// 为什么:provider 只管"怎么发请求",Models 负责"用哪把钥匙发"——先解析凭证、注入请求头,再委托。
// 谁在调用:上层应用(agent/coding-agent)持有的就是它;实现见下方 ModelsImpl,工厂见 createModels()。
export interface Models {
	// 列出全部 / 按 id 查找已注册的 provider。
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;

	// 同步读取某 provider(或全部)当前已知的模型清单;某个 provider 抛错时按空清单处理(尽力而为)。
	/**
	 * Sync read of last-known models from one provider or all providers.
	 * Best-effort: a provider whose `getModels()` throws yields no models.
	 */
	getModels(provider?: string): readonly Model<Api>[];

	// 按 provider + 模型 id 同步查找;返回类型是 Model<Api>,用 hasApi() 收窄后再走 stream 才有精确类型。
	/**
	 * Sync runtime model lookup against last-known lists. Dynamic model lists
	 * are typed as `Model<Api>`; narrow with the `hasApi()` type guard.
	 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	// 并发刷新所有已配置的动态 provider;静态与未配置的跳过,错误与取消收集进返回值而不抛出。
	/**
	 * Refresh every configured dynamic provider concurrently. Provider errors and cancellation
	 * are returned without rejecting; static and unconfigured providers are skipped.
	 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

	// 检查 provider 鉴权是否配置完整(不触发 OAuth 刷新),主要供 UI 显示登录状态。
	/** Check whether a provider has complete auth configuration without refreshing OAuth. */
	checkAuth(providerId: string): Promise<AuthCheck | undefined>;

	// 返回"鉴权已配好"的 provider 的模型清单(再套 provider 自己的 filterModels 策略)。
	/** Return models whose providers have complete auth configuration. */
	getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;

	// 解析 provider 的有效鉴权(存储凭证/环境变量/静态 key);传 model 时额外合并模型自带的静态请求头。
	// 未配置返回 undefined;OAuth 刷新失败抛 ModelsError("oauth"),其余鉴权失败抛 ModelsError("auth")。
	/**
	 * Resolve provider-scoped auth by provider id, or provider auth plus static
	 * model headers when passed a model. Includes a source label for status UI.
	 * Resolves `undefined` when the provider is unknown or unconfigured.
	 * Rejects with `ModelsError`: code "oauth" when a token refresh fails (the
	 * stored credential is preserved for retry; re-login fixes it), code "auth"
	 * when api-key resolution or the credential store fails. Request paths
	 * surface rejections as stream errors.
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	// 执行 provider 自己的登录流程(OAuth 跳转或交互式输入 key)并持久化返回的凭证。
	/** Run a provider-owned login flow and persist its returned credential. */
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;

	// 删除该 provider 已存储的凭证。
	/** Remove the stored credential for a provider. */
	logout(providerId: string): Promise<void>;

	// 请求入口(stream 路径):解析鉴权 -> 合并请求头 -> 委托给模型所属 provider 的 stream。
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	// complete 是 stream 的便捷封装:收集完整流后返回最终 AssistantMessage(非流式调用方使用)。
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	// 同上,但走协议无关的简化选项路径(streamSimple/completeSimple)。
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
}

// Models 的可变版本:允许运行时增删 provider(注册自定义厂商、测试中替换实现)。createModels() 返回此类型。
export interface MutableModels extends Models {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

// createModels() 的可选注入项:凭证存储、模型清单存储、鉴权宿主环境;缺省全部用内存版/默认实现。
export interface CreateModelsOptions {
	credentials?: CredentialStore;
	modelsStore?: ModelsStore;
	authContext?: AuthContext;
}

// 合并两组请求头,override 覆盖 base。HTTP 头大小写不敏感,先按小写去重再写入,避免同名头并存。
// 被 getAuth()(合并模型级头)和 applyAuth()(合并鉴权头与调用方头)使用。
function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

// Models/MutableModels 的默认实现:一个 provider 注册表 + 凭证存储 + 模型清单存储 + 鉴权上下文。
// 是什么:上面 Models 接口所有方法的落地。
// 为什么:把鉴权解析、凭证刷新、清单刷新这些横切逻辑集中在这里,让 provider 实现保持纯粹。
// 谁在调用:外部不直接 new,而是通过下方 createModels() 创建。
class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private modelsStore: ModelsStore;
	private authContext: AuthContext;

	// 三个依赖都可注入;缺省为内存凭证存储、内存模型存储、默认鉴权上下文(便于测试与嵌入式使用)。
	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: Provider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	// 同步清单读取:单个 provider 或全量合并;provider 实现抛错时吞掉并按空清单处理。
	getModels(provider?: string): readonly Model<Api>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	// refresh():并发刷新所有实现了 refreshModels 的动态 provider。
	// 流程(每个 provider):读存储的凭证 -> resolveRefreshCredential 解析/刷新 -> 调 provider.refreshModels;
	// 出错时记录错误并回退到"离线模式再跑一次"以至少恢复缓存;取消信号全程生效,错误不抛出。
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		const errors = new Map<string, Error>();
		const refreshable = Array.from(this.providers.values()).filter(
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				provider.refreshModels !== undefined,
		);

		await Promise.all(
			refreshable.map(async (provider) => {
				if (options.signal?.aborted) return;
				const store: ProviderModelsStore = {
					read: () => this.modelsStore.read(provider.id),
					write: (entry) => this.modelsStore.write(provider.id, entry),
					delete: () => this.modelsStore.delete(provider.id),
				};
				let stored: Credential | undefined;
				try {
					stored = await this.readCredential(provider.id);
					const credential = await this.resolveRefreshCredential(provider, stored, allowNetwork, options.signal);
					if (!credential) return;
					await provider.refreshModels({
						credential,
						store,
						allowNetwork,
						force: options.force,
						signal: options.signal,
					});
				} catch (error) {
					if (!options.signal?.aborted) {
						errors.set(
							provider.id,
							error instanceof Error
								? error
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
					try {
						await provider.refreshModels({
							credential: stored,
							store,
							allowNetwork: false,
							signal: options.signal,
						});
					} catch {
						// Preserve the original auth/network error; cache restoration is best-effort here.
					}
				}
			}),
		);

		return { aborted: options.signal?.aborted ?? false, errors };
	}

	// 为刷新解析有效凭证:OAuth 未过期直接用,过期且允许联网则通过 credentials.modify 原子地刷新并持久化;
	// 否则走 apiKey.resolve()(可能读环境变量或静态配置)。返回 undefined 表示该 provider 未配置。
	private async resolveRefreshCredential(
		provider: Provider,
		stored: Credential | undefined,
		allowNetwork: boolean,
		signal?: AbortSignal,
	): Promise<Credential | undefined> {
		if (stored?.type === "oauth") {
			const oauth = provider.auth.oauth;
			if (!oauth) return undefined;
			if (!allowNetwork || Date.now() < stored.expires) return stored;
			if (signal?.aborted) return undefined;
			const post = await this.credentials.modify(provider.id, async (current) => {
				if (current?.type !== "oauth" || Date.now() < current.expires) return undefined;
				return oauth.refresh(current, signal);
			});
			return post?.type === "oauth" ? post : undefined;
		}

		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		const credential = stored?.type === "api_key" ? stored : undefined;
		const result = await apiKey.resolve({ ctx: this.authContext, credential });
		if (!result) return undefined;
		return { type: "api_key", key: result.auth.apiKey, env: result.env };
	}

	// 读凭证,并把存储层错误统一包装成 ModelsError("auth")。
	private async readCredential(providerId: string): Promise<Credential | undefined> {
		try {
			return await this.credentials.read(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	// 判断 provider 鉴权是否就绪:有 OAuth 凭证即就绪;apiKey 有自定义 check 就用它,
	// 否则退化为完整 resolveProviderAuth 看能否解析出 key。
	private async checkProviderAuth(
		provider: Provider,
		credential: Credential | undefined,
	): Promise<AuthCheck | undefined> {
		if (credential?.type === "oauth") {
			return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		}
		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		if (apiKey.check) {
			try {
				return await apiKey.check({
					ctx: this.authContext,
					credential: credential?.type === "api_key" ? credential : undefined,
				});
			} catch (error) {
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
			}
		}

		const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext);
		return resolution ? { source: resolution.source, type: "api_key" } : undefined;
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return this.checkProviderAuth(provider, await this.readCredential(providerId));
	}

	// 并发检查各 provider 鉴权,返回"已配置"者的模型清单(经 filterModels 按凭证过滤)。
	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		const providers = providerId
			? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
			: this.getProviders();
		const checks = await Promise.all(
			providers.map(async (provider) => {
				const credential = await this.readCredential(provider.id);
				return { provider, credential, auth: await this.checkProviderAuth(provider, credential) };
			}),
		);
		return checks.flatMap(({ provider, credential, auth }) => {
			if (!auth) return [];
			const models = provider.getModels();
			return provider.filterModels?.(models, credential) ?? models;
		});
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	// getAuth():按 provider id 或 model 解析有效鉴权;传 model 时把模型自带的静态 headers 合并进结果,
	// 供需要特殊请求头的模型使用。未配置时返回 undefined,由调用方决定报错或提示登录。
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		return {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
	}

	// 调 provider 自带的 login 流程,成功后通过 credentials.modify 原子持久化凭证。
	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const provider = this.providers.get(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) {
			throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		}
		const credential = await method.login(interaction);
		try {
			await this.credentials.modify(providerId, async () => credential);
		} catch (error) {
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		return credential;
	}

	async logout(providerId: string): Promise<void> {
		try {
			await this.credentials.delete(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
		}
	}

	// 按 model.provider 找到对应 provider,找不到抛 ModelsError("provider")——所有请求路径的第一道校验。
	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	// applyAuth():所有请求路径共用的鉴权应用步骤。
	// 做什么:解析有效鉴权 -> 按"显式入参逐字段优先"合并 apiKey/headers/env -> 应用 transformHeaders 钩子
	//        -> 用鉴权给出的 baseUrl 覆盖模型 -> 组装协议实现认识的 StreamOptions。
	// 为什么在这里:provider/协议实现不操心凭证从哪来,拿到的一定是可直接发请求的参数。
	private async applyAuth<TOptions extends StreamOptions & ModelsStreamTransforms>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ requestModel: Model<Api>; requestOptions: StreamOptions | undefined }> {
		this.requireProvider(model);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
		});
		if (!resolution) {
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		const auth = resolution.auth;

		// Explicit request options win per-field; the Models-only transform runs last.
		const apiKey = options?.apiKey ?? auth.apiKey;
		let headers = mergeHeaders(auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = { ...providerOptions, apiKey, headers, env } as StreamOptions;

		return { requestModel, requestOptions };
	}

	// stream():lazyStream 包裹——鉴权是异步的,延迟到流开始被消费时才执行,然后委托 provider.stream。
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(
				model,
				options as ModelsApiStreamOptions<Api> | undefined,
			);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	// complete():收集整条流,返回最终组装的 AssistantMessage。
	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	// streamSimple():与 stream() 相同的鉴权-委托流程,但传协议无关的 SimpleStreamOptions。
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions as SimpleStreamOptions);
		});
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
}

// createModels():创建 Models 集合的工厂(返回可变版本,便于注册 provider)。
// 是什么:ModelsImpl 的对外构造入口,依赖(凭证/模型存储、鉴权上下文)可注入。
// 谁在调用:应用启动时(coding-agent 初始化)创建单例,再逐个 setProvider 注册内置/自定义厂商。
export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

// createProvider() 的入参:组装一个 Provider 所需的全部零件(身份、鉴权、模型清单、协议实现)。
export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** Display name. Default: `id`. */
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	auth: ProviderAuth;
	/** Static baseline model list (empty for purely dynamic providers). */
	models: readonly Model<TApi>[];
	/** Fetch a dynamic model overlay. createProvider restores/persists it through ModelsStore. */
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	// api 字段是关键:单个协议实现(该厂商所有模型共用),或按 model.api 索引的映射(混合协议厂商)。
	/** Single implementation, or map keyed by `model.api` for mixed-API providers. */
	api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

/**
 * Builds a provider from parts. Built-in provider factories and models.json
 * custom providers both go through this. A single `api` streams all models;
 * an `api` map dispatches on `model.api`, and a model whose api has no entry
 * produces a stream error.
 */
// 【核心工厂】createProvider():把散件(身份/鉴权/模型清单/协议实现)组装成一个完整 Provider。
// 是什么:providers/*.ts 的内置厂商工厂和 models.json 自定义厂商都最终调用它。
// 为什么加新厂商不用改这里:协议分发是按 model.api 查表完成的(见下方 apiFor/dispatch)——
//   新厂商只需在 api/*.ts 提供协议实现(或复用已有的,如 openai-completions),在自己的工厂里
//   把它填进 options.api 即可。本函数没有任何 if(厂商名) 分支,天然对新厂商开放。
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	const baselineModels = input.models;
	let dynamicModels: readonly Model<TApi>[] = [];
	let inflightRefresh: Promise<void> | undefined;
	const fetchModels = input.fetchModels;
	// 当前模型清单 = 静态基线 + 动态覆盖层(同 id 覆盖基线,新 id 追加)。
	const currentModels = (): readonly Model<TApi>[] => {
		const merged = [...baselineModels];
		for (const model of dynamicModels) {
			const index = merged.findIndex((entry) => entry.id === model.id);
			if (index >= 0) merged[index] = model;
			else merged.push(model);
		}
		return merged;
	};
	// 判定 api 入参形态:带 .stream 函数就是单一实现;否则视为按 model.api 索引的映射。
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);

	// 【dispatch 核心】按 model.api 选协议实现:单实现直接用;映射则查表。
	// api/*.ts 的每个模块导出符合 ProviderStreams 的实现,这里按协议名取到对应的那一个。
	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	// 统一分发:找不到对应协议实现时返回一个"惰性失败"的流(开始消费时才抛 ModelsError),
	// 保持与正常路径相同的返回类型;找到则执行调用方给定的 run(stream 或 streamSimple)。
	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};

	return {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: currentModels,
		// refreshModels:先从 ModelsStore 恢复上次缓存的清单,允许联网时再拉取新清单并持久化;
		// inflightRefresh 为并发调用去重;失败时保留旧清单(与 ModelsImpl.refresh 的离线回退配合)。
		refreshModels: fetchModels
			? (context) => {
					inflightRefresh ??= (async () => {
						try {
							const stored = await context.store.read();
							if (stored) {
								dynamicModels = stored.models
									.filter((model) => model.provider === input.id)
									.map((model) => model as Model<TApi>);
							}
							if (!context.allowNetwork || context.signal?.aborted) return;
							const refreshed = await fetchModels(context);
							if (context.signal?.aborted) return;
							dynamicModels = refreshed;
							await context.store.write({ models: refreshed, checkedAt: Date.now() });
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		filterModels: input.filterModels,
		// stream 与 streamSimple 都经 dispatch 按 model.api 选实现,区别仅在传给实现的选项类型
		// (协议特定的 ApiStreamOptions vs 协议无关的 SimpleStreamOptions)。
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};
}

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 */
// hasApi():类型守卫——运行时检查 model.api,并把类型收窄为 Model<TApi>。
// 是什么:动态查到的模型类型是 Model<Api>,收窄后 stream 的 options 才有精确的协议类型。
// 为什么:TypeScript 无法从运行时的 api 字符串自动推导泛型,需要显式守卫。
// 谁在调用:上层在拿到 Models.getModel() 结果后、调用 stream 之前使用。
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
	return model.api === api;
}

// calculateCost():按模型费率把一次请求的 token 用量折算成美元成本,结果写回 usage.cost。
// 是什么:支持分段计价(输入 token 超过阈值时启用对应费率档,取命中的最高档);
//        Anthropic 的 1 小时缓存写按 2 倍输入价计费。
// 为什么:状态栏实时费用、cost 统计脚本(scripts/cost.ts)都依赖它。
// 谁在调用:agent 层在每条 assistant 消息的 usage 更新时调用。
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	// 分段计价:在费率档中找"输入 token 数已超过的、阈值最高"的那一档作为实际费率。
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// 缓存写费用拆开算:短时缓存写按 cacheWrite 价,1 小时长缓存写按 2 倍输入价(下方英文为原始说明)。
	// Anthropic charges 2x base input for 1h cache writes.
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// 返回模型支持的思考等级列表:非推理模型只有 "off";thinkingLevelMap 中映射为 null 的等级被排除,
// "xhigh"/"max" 两档必须显式声明映射才可用。供 UI 渲染思考强度选项。
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

// 把请求的思考等级钳制到模型支持的范围内:先向上找最近的可用档,再向下找,兜底 "off"。
// 供切换模型时把上一模型的思考等级安全迁移过来。
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
// 按 (id, provider) 二元组判断两个模型是否同一个;任一为空返回 false。供 UI 比较选中模型。
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
