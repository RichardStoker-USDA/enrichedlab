/** What the person typed in a browser's address field, as an address: a URL, a local app, or a web search. */
export function normalize(text: string): string {
	const t = text.trim();
	if (!t) return "";
	if (/^https?:\/\//i.test(t)) return t;
	if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
	return /\s/.test(t) || !/\./.test(t) ? `https://duckduckgo.com/?q=${encodeURIComponent(t)}` : `https://${t}`;
}
