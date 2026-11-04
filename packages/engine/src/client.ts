// A Lab protocol client for Node and Bun surfaces (the terminal, the CLI, tests). The web surface has its own.

import WebSocket from "ws";
import type { EngineFile, Method, Notification, Notifications, Params, Result, RpcResponse } from "@enrichedlab/protocol";

export class EngineClient {
	private ws: WebSocket;
	private next = 1;
	private waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private handlers = new Map<string, Set<(params: unknown) => void>>();
	private opened: Promise<void>;
	onClose?: () => void;

	constructor(file: EngineFile, name: string) {
		this.ws = new WebSocket(`ws://127.0.0.1:${file.port}/rpc`, { headers: { authorization: `Bearer ${file.token}`, "user-agent": name } });
		this.opened = new Promise((resolve, reject) => {
			this.ws.once("open", () => resolve());
			this.ws.once("error", (error) => reject(error));
		});
		this.ws.on("message", (data) => {
			let message: RpcResponse & { method?: string; params?: unknown };
			try {
				message = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (message.method) {
				for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
				return;
			}
			const pending = this.waiting.get(message.id as number);
			if (!pending) return;
			this.waiting.delete(message.id as number);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
		});
		this.ws.on("close", () => {
			for (const pending of this.waiting.values()) pending.reject(new Error("The engine connection closed."));
			this.waiting.clear();
			this.onClose?.();
		});
	}

	ready(): Promise<void> {
		return this.opened;
	}

	async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
		await this.opened;
		const id = this.next++;
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	on<N extends Notification>(name: N, handler: (params: Notifications[N]) => void): () => void {
		let set = this.handlers.get(name);
		if (!set) this.handlers.set(name, (set = new Set()));
		set.add(handler as (params: unknown) => void);
		return () => set!.delete(handler as (params: unknown) => void);
	}

	close(): void {
		this.ws.close();
	}
}
