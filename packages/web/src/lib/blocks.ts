// Splitting streamed Markdown into finished blocks and the one still being written. No DOM, so it runs in tests.

/**
 * Streaming text as finished blocks plus the one still being written. A blank line outside a code fence ends a
 * block; finished blocks render once (cached), so each update re-renders only the tail instead of the whole answer.
 */
export function splitBlocks(text: string): { settled: string[]; open: string } {
	const settled: string[] = [];
	let fence: string | undefined;
	let start = 0;
	let pos = 0;
	while (pos < text.length) {
		const end = text.indexOf("\n", pos);
		if (end < 0) break;
		const line = text.slice(pos, end);
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? undefined : marker;
		else if (!fence && line.trim() === "" && end > start) {
			const block = text.slice(start, end).trim();
			if (block) settled.push(block);
			start = end + 1;
		}
		pos = end + 1;
	}
	return { settled, open: text.slice(start) };
}
