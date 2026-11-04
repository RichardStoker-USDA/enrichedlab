// A process in a lab sandbox with its stdin and output streamed (GET /v1/containers/{id}/attach): a WebSocket of JSON
// text frames. The first frame is the command; then {stdin} (base64), {eof} and {signal} go in, and {stdout} and
// {stderr} (base64) come back until {exit_code}. App backends in a lab session run this way, so the lab's data stays
// inside the lab: an MCP backend speaks its protocol over the process's stdin and stdout (AttachTransport).

import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";

export interface AttachSpec {
	argv: string[];
	workdir?: string;
	env?: Record<string, string>;
	timeout_seconds?: number;
}

export interface Attached {
	write(data: string | Uint8Array): void;
	/** Close the process's stdin. */
	end(): void;
	signal(name: "TERM" | "KILL"): void;
	onStdout(listener: (chunk: Uint8Array) => void): void;
	onStderr(listener: (chunk: Uint8Array) => void): void;
	/** The exit code, null when the process was stopped; rejects when the lab refused or the connection broke. */
	readonly exit: Promise<number | null>;
	close(): void;
}

const b64 = (data: string | Uint8Array) => Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64");

/** Open `url` (ws or wss) with the lab's sign-in headers and start `spec`. Resolves once the socket is open. */
export function attachSocket(url: string, headers: Record<string, string>, spec: AttachSpec, ca?: string): Promise<Attached> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers, ...(ca ? { tls: { ca } } : {}) } as unknown as string[]);
		const stdout: ((chunk: Uint8Array) => void)[] = [];
		const stderr: ((chunk: Uint8Array) => void)[] = [];
		let settle!: { done(code: number | null): void; fail(error: Error): void };
		let finished = false;
		const exit = new Promise<number | null>((done, fail) => {
			settle = { done, fail };
		});
		exit.catch(() => undefined);
		const send = (frame: Record<string, unknown>) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
		};
		socket.onopen = () => {
			socket.send(JSON.stringify(spec));
			resolve({
				write: (data) => send({ stdin: b64(data) }),
				end: () => send({ eof: true }),
				signal: (name) => send({ signal: name }),
				onStdout: (listener) => void stdout.push(listener),
				onStderr: (listener) => void stderr.push(listener),
				exit,
				close: () => socket.close(),
			});
		};
		socket.onmessage = (event) => {
			let frame: { stdout?: string; stderr?: string; exit_code?: number | null; error?: { code?: string; message?: string } };
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (typeof frame.stdout === "string") for (const listener of stdout) listener(Buffer.from(frame.stdout, "base64"));
			if (typeof frame.stderr === "string") for (const listener of stderr) listener(Buffer.from(frame.stderr, "base64"));
			if ("exit_code" in frame) {
				finished = true;
				settle.done(frame.exit_code ?? null);
			}
			if (frame.error) {
				finished = true;
				settle.fail(Object.assign(new Error(frame.error.message ?? frame.error.code ?? "The lab refused the process."), { code: frame.error.code }));
			}
		};
		socket.onerror = () => {
			const error = new Error("The connection to the lab sandbox failed.");
			reject(error);
			if (!finished) settle.fail(error);
		};
		socket.onclose = () => {
			if (!finished) settle.fail(new Error("The lab closed the connection before the process ended."));
		};
	});
}

/** MCP over an attached process's stdin and stdout: one JSON-RPC message per line, as MCP's stdio transport sends. */
export class AttachTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	private process?: Attached;
	private buffer = "";
	private decoder = new TextDecoder();

	constructor(
		private open: () => Promise<Attached>,
		private log: (line: string) => void = () => undefined,
	) {}

	async start(): Promise<void> {
		const process = await this.open();
		this.process = process;
		process.onStdout((chunk) => {
			this.buffer += this.decoder.decode(chunk, { stream: true });
			for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
				const line = this.buffer.slice(0, end).replace(/\r$/, "");
				this.buffer = this.buffer.slice(end + 1);
				if (!line.trim()) continue;
				try {
					this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
				} catch (error) {
					this.onerror?.(error as Error);
				}
			}
		});
		const errors = new TextDecoder();
		process.onStderr((chunk) => {
			for (const line of errors.decode(chunk, { stream: true }).split("\n")) if (line.trim()) this.log(line);
		});
		process.exit.then(
			(code) => {
				if (code) this.log(`The backend stopped (exit ${code}).`);
				this.onclose?.();
			},
			(error: Error) => {
				this.onerror?.(error);
				this.onclose?.();
			},
		);
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.process) throw new Error("The backend isn't running.");
		this.process.write(`${JSON.stringify(message)}\n`);
	}

	async close(): Promise<void> {
		const process = this.process;
		this.process = undefined;
		if (!process) return;
		process.end();
		process.signal("TERM");
		process.close();
	}
}
