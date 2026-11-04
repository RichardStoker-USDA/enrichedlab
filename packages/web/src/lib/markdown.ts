// Agent prose to safe HTML: Markdown through marked, then DOMPurify. Links open in a new window, never in the app.

import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: false });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
	}
});

const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
	const hit = cache.get(text);
	if (hit !== undefined) return hit;
	const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { USE_PROFILES: { html: true } });
	if (cache.size > 500) cache.clear();
	cache.set(text, html);
	return html;
}

/** Markdown still streaming: render it as it is, without caching every partial state. */
export function renderPartial(text: string): string {
	return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { USE_PROFILES: { html: true } });
}

export { splitBlocks } from "./blocks.ts";
