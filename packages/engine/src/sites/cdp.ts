// A Chrome DevTools Protocol connection: JSON commands with ids over one WebSocket, answers matched by id, events by
// method. Sessions are flattened (Target.attachToTarget with flatten), so one socket carries the browser and its
// pages. A lab's sandbox browser is reached this way through the lab's port path (sandbox_browser.ts).

type Listener = (params: Record<string, unknown>, session?: string) => void;

export class CdpError extends Error {
	constructor(
		readonly method: string,
		message: string,
		readonly code?: number,
	) {
		super(`${method}: ${message}`);
	}
}

export class Cdp {
	private next = 1;
	private pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: Error): void }>();
	private listeners = new Map<string, Set<Listener>>();
	private closers = new Set<(why: Error) => void>();
	closed?: Error;

	private constructor(private socket: WebSocket) {
		socket.onmessage = (event) => {
			let message: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (message.id !== undefined) {
				const waiting = this.pending.get(message.id);
				if (!waiting) return;
				this.pending.delete(message.id);
				if (message.error) waiting.reject(new CdpError(waiting.method, message.error.message ?? "failed", message.error.code));
				else waiting.resolve(message.result ?? {});
				return;
			}
			if (message.method) for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
		};
		const end = (why: Error) => {
			if (this.closed) return;
			this.closed = why;
			for (const waiting of this.pending.values()) waiting.reject(why);
			this.pending.clear();
			for (const closer of this.closers) closer(why);
		};
		socket.onclose = () => end(new Error("The connection to the sandbox browser closed."));
		socket.onerror = () => end(new Error("The connection to the sandbox browser failed."));
	}

	/** Open `url` (ws or wss) with these headers. Resolves once the socket is open. */
	static open(url: string, headers: Record<string, string>, ca?: string): Promise<Cdp> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url, { headers, ...(ca ? { tls: { ca } } : {}) } as unknown as string[]);
			socket.onopen = () => resolve(new Cdp(socket));
			socket.onerror = () => reject(new Error("Couldn't reach the sandbox browser."));
		});
	}

	send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, session?: string, timeoutMs = 30_000): Promise<T> {
		if (this.closed) return Promise.reject(this.closed);
		const id = this.next++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CdpError(method, "the browser didn't answer in time"));
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: (value) => (clearTimeout(timer), resolve(value as T)),
				reject: (error) => (clearTimeout(timer), reject(error)),
			});
			this.socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
		});
	}

	/** Listen for an event; returns a function that stops listening. */
	on(method: string, listener: Listener): () => void {
		let set = this.listeners.get(method);
		if (!set) this.listeners.set(method, (set = new Set()));
		set.add(listener);
		return () => set.delete(listener);
	}

	/** The first `method` event for which `match` holds, or undefined after `timeoutMs`. */
	waitFor(method: string, match: (params: Record<string, unknown>, session?: string) => boolean, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => (off(), resolve(undefined)), timeoutMs);
			const off = this.on(method, (params, session) => {
				if (!match(params, session)) return;
				clearTimeout(timer);
				off();
				resolve(params);
			});
		});
	}

	onClose(listener: (why: Error) => void): void {
		this.closers.add(listener);
	}

	close(): void {
		this.socket.close();
	}
}
