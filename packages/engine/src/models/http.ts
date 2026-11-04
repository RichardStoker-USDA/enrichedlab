// HTTP for model and site calls: a private CA when an endpoint has one, and server-sent events read line by line.

import { ModelHttpError } from "./types.ts";

export interface FetchOptions extends RequestInit {
	ca?: string;
}

/** fetch with an optional private CA. Bun reads `tls.ca`; elsewhere a private CA needs NODE_EXTRA_CA_CERTS. */
export function labFetch(url: string, options: FetchOptions = {}): Promise<Response> {
	const { ca, ...init } = options;
	const withTls = ca ? ({ ...init, tls: { ca } } as RequestInit) : init;
	return fetch(url, withTls);
}

/** Yield each `data:` payload of an event stream. Ends at `[DONE]` or the end of the body. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event: string | undefined;
	let data: string[] = [];
	const abort = () => reader.cancel().catch(() => undefined);
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line === "") {
					if (data.length) {
						const payload = data.join("\n");
						if (payload === "[DONE]") return;
						yield { event, data: payload };
					}
					event = undefined;
					data = [];
				} else if (line.startsWith("data:")) {
					data.push(line.slice(line.charAt(5) === " " ? 6 : 5));
				} else if (line.startsWith("event:")) {
					event = line.slice(6).trim();
				}
			}
		}
		if (data.length && data.join("\n") !== "[DONE]") yield { event, data: data.join("\n") };
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}

const OVERFLOW = /context|too long|maximum.*tokens|max_model_len|prompt is too long|exceeds/i;

/** Turn a non-2xx response into a ModelHttpError with a short, secret-free message. */
export async function httpError(response: Response, who: string): Promise<ModelHttpError> {
	let message = "";
	try {
		const text = await response.text();
		try {
			const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string; detail?: string };
			const error = parsed.error;
			message = (typeof error === "string" ? error : error?.message) ?? parsed.message ?? parsed.detail ?? text;
		} catch {
			message = text;
		}
	} catch {
		// The body is optional.
	}
	message = message.replace(/\s+/g, " ").trim().slice(0, 400);
	const status = response.status;
	const retryAfter = Number(response.headers.get("retry-after"));
	const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
	const overflow = (status === 400 || status === 413) && OVERFLOW.test(message);
	return new ModelHttpError(
		status,
		`${who} answered ${status}${message ? `: ${message}` : ""}`,
		retryable,
		Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
		overflow,
	);
}
