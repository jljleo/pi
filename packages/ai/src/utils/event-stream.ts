/*
 * 本文件定位:
 *   EventStream<T, R> 是 ai 包流式输出的核心抽象。模型提供商的 SDK 大多以
 *   SSE(Server-Sent Events,服务器主动推送)的方式把增量内容推过来,属于
 *   push 模型;而 TypeScript 消费端最自然的写法是 `for await (const ev of stream)`,
 *   属于 pull 模型(消费者主动拉取)。本类就是两者之间的桥:生产者一侧调用
 *   push()/end() 塞事件,消费者一侧用 for-await 逐个取事件,同时 result()
 *   能在流结束后取到一个"最终结果"(对助手消息流来说就是完整的 AssistantMessage)。
 *
 * 与其他文件的关系:
 *   - types.ts 定义了 AssistantMessage / AssistantMessageEvent 等事件类型,
 *     本文件只依赖类型,不含任何事件结构逻辑。
 *   - providers/api 目录下的各 api/*.ts(anthropic、openai 等)负责把各家 SDK 的
 *     原始流翻译成统一的 AssistantMessageEvent,然后调用 push() 灌进本流;
 *     上层的 agent 循环再用 for-await 消费这些事件。
 *
 * 阅读建议:先看字段(三个状态:queue / waiting / done),再看 push() 的
 * 分发逻辑(有人等就直接给,没人等就排队),最后看 [Symbol.asyncIterator]
 * 如何按"先清队列、再看 done、否则挂起等待"的顺序消费。
 */
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

// Generic event stream class for async iteration
// 通用事件流类:T 是单个事件类型,R 是流结束后 result() 返回的最终结果类型(默认同 T)
export class EventStream<T, R = T> implements AsyncIterable<T> {
	// 已推送但尚未被消费者取走的事件队列(push 时无人等待则先进队)
	private queue: T[] = [];
	// 挂起中的消费者 resolve 回调列表:for-await 拉到空且流未结束时,
	// 会把 Promise 的 resolve 存到这里,等下一次 push()/end() 时唤醒
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	// 流是否已结束(收到完成事件或调用了 end());结束后 push() 变成空操作
	private done = false;
	// result() 返回的 Promise:在收到完成事件(或 end(result))时兑现
	private finalResultPromise: Promise<R>;
	// 上面的 Promise 的 resolve 函数,构造时从 Promise 回调里"借"出来保存;
	// 感叹号表示由构造函数保证赋值,绕开 TS 的严格初始化检查
	private resolveFinalResult!: (result: R) => void;
	// 由调用方注入:判断某个事件是否为"终态事件"(如 done / error)
	private isComplete: (event: T) => boolean;
	// 由调用方注入:从终态事件中提取最终结果 R(如取出完整 AssistantMessage)
	private extractResult: (event: T) => R;

	// 构造函数只接收两个策略回调,事件类型本身完全由泛型决定,因此本类与具体事件结构解耦
	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		// 手动创建一个 Promise 并把 resolve 存到字段里,之后任何时机都能兑现它
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	// 生产者入口:推入一个事件。SDK 的每个 SSE 增量都会走到这里
	push(event: T): void {
		// 流已结束则静默丢弃,保证 done 之后状态不再变化(幂等保护)
		if (this.done) return;

		// 若该事件是终态事件:标记结束,并用它兑现 result() 的 Promise。
		// 注意终态事件本身仍会继续下发给消费者(见下方),不会丢失
		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		// 优先唤醒最早挂起的消费者(FIFO);没有等待者则把事件排入队列缓冲
		const waiter = this.waiting.shift();
		if (waiter) {
			// 直接以 done:false 的 IteratorResult 兑现挂起的 Promise,消费者随即拿到该事件
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	// 显式结束流(例如网络中断、提前终止等没有终态事件的情形)
	end(result?: R): void {
		this.done = true;
		// 若调用方给出了最终结果,就直接兑现 result();否则该 Promise 可能永不兑现,
		// 由调用方负责保证 await result() 的使用场景安全
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		// 唤醒所有挂起的消费者,以 done:true 让它们的 for-await 正常退出循环
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			// value 在 done:true 时按协议无意义,这里用 undefined 占位
			waiter({ value: undefined as any, done: true });
		}
	}

	// AsyncIterable 协议实现:for-await 会调用此方法拿到一个异步迭代器。
	// 用 async 生成器(async function*)实现,每次 yield 一个事件,return 即迭代结束。
	// 消费顺序是固定的三级判断:先清空积压队列 -> 流已结束则退出 -> 否则挂起等待新事件。
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			// 1) 队列里有缓冲事件:按 FIFO 逐个吐出(生产者比消费者快的场景)
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				// 2) 队列空且流已结束:结束迭代,for-await 循环退出
				return;
			} else {
				// 3) 队列空但流未结束:创建 Promise 并把 resolve 挂到 waiting 列表,
				//    自己 await 住;后续 push() 或 end() 会负责兑现它
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				// end() 发来的 done:true 信号:结束迭代
				if (result.done) return;
				// push() 发来的新事件:交给 for-await 循环体
				yield result.value;
			}
		}
	}

	// 获取最终结果:返回构造时创建的 Promise,在终态事件到达(或 end(result))时兑现。
	// 典型用法:一边 for-await 消费增量事件做 UI 渲染,一边 await stream.result() 拿完整消息
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

// 面向助手消息流的特化版本:事件是 AssistantMessageEvent,最终结果是完整的 AssistantMessage。
// 这就是 agent 主循环实际持有的流类型
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			// 终态判定:done(正常完成)或 error(出错)都算流结束
			(event) => event.type === "done" || event.type === "error",
			// 终态提取:done 事件携带完整消息,error 事件携带出错时的部分消息
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				// 理论上不可达:isComplete 已保证只有 done/error 会走到这里
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
// 工厂函数:供扩展(extensions)使用,避免扩展代码直接 new 内部类、耦合构造细节
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
