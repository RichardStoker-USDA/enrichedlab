export function ago(iso: string, now = Date.now()): string {
	const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
	return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function tokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
	return String(n);
}

export function folderName(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

export function shortPath(path: string): string {
	return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~").replace(/^C:\\Users\\[^\\]+/i, "~");
}

/** The useful part of tool arguments still streaming: a path or command if one has appeared. */
export function argPreview(args: string): string {
	const match = /"(path|command|pattern|url|title|query)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(args);
	return match ? match[2].replace(/\\n/g, " ").replace(/\\"/g, '"') : "";
}
