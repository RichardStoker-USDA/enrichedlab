// The browser's Lab protocol client. The page is served by the engine, so the WebSocket goes back to the same
// origin, carrying the key the pairing link stored for this origin. It reconnects on its own and tells the store.

import type { Method, Notification, Notifications, Params, Result } from "@enrichedlab/protocol";

type Handler = (params: unknown) => void;

export class Rpc {
	private ws?: WebSocket;
	private next = 1;
	private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private handlers = new Map<string, Set<Handler>>();
	private queue: string[] = [];
	private retry = 0;
	connected = false;
	onState?: (connected: boolean, reconnected: boolean) => void;

	connect(): void {
		const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;
		let key: string | null = null;
		try {
			key = localStorage.getItem("lab.key");
		} catch {
			// Storage blocked: the engine will refuse the connection and the page says how to open it.
		}
		const ws = new WebSocket(url, key ? ["lab", `key.${key}`] : ["lab"]);
		this.ws = ws;
		ws.onopen = () => {
			const reconnected = this.retry > 0;
			this.retry = 0;
			this.connected = true;
			for (const message of this.queue.splice(0)) ws.send(message);
			this.onState?.(true, reconnected);
		};
		ws.onmessage = (event) => {
			const message = JSON.parse(event.data as string) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
			if (message.method) {
				for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
				return;
			}
			const pending = this.waiting.get(message.id as number);
			if (!pending) return;
			this.waiting.delete(message.id as number);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		};
		ws.onclose = () => {
			this.connected = false;
			for (const pending of this.waiting.values()) pending.reject(new Error("Connection lost."));
			this.waiting.clear();
			// Their callers were told they failed; sending them on reconnect would run them twice.
			this.queue = [];
			this.onState?.(false, false);
			this.retry++;
			// The desktop shell watches for this and pairs with a restarted engine.
			if (this.retry === 4) console.warn("lab:engine-lost");
			setTimeout(() => this.connect(), Math.min(5_000, 250 * 2 ** Math.min(this.retry, 5)));
		};
	}

	call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
		const id = this.next++;
		const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
			if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
			else this.queue.push(text);
		});
	}

	on<N extends Notification>(name: N, handler: (params: Notifications[N]) => void): () => void {
		let set = this.handlers.get(name);
		if (!set) this.handlers.set(name, (set = new Set()));
		set.add(handler as Handler);
		return () => set!.delete(handler as Handler);
	}
}

export const rpc = new Rpc();
