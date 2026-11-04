// File checkpoints: before a tool changes a file, its bytes (or its absence) are kept beside the session log, so a
// turn's file changes can be undone. Shell commands aren't covered; they can change anything.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One file as it was before a change. `blob` names the stored bytes; absent when the file didn't exist. */
export interface FileBefore {
	path: string;
	existed: boolean;
	blob?: string;
}

/** Files larger than this aren't kept; undo leaves them as they are and says so. */
const MAX_BYTES = 25 * 1024 * 1024;

export class Checkpoints {
	constructor(private dir: string) {}

	/** Record each path as it is now. Paths must be absolute. */
	capture(paths: string[]): FileBefore[] {
		const out: FileBefore[] = [];
		for (const path of paths) {
			if (!existsSync(path)) {
				out.push({ path, existed: false });
				continue;
			}
			const info = statSync(path);
			if (!info.isFile() || info.size > MAX_BYTES) continue;
			const bytes = readFileSync(path);
			const blob = createHash("sha256").update(bytes).digest("hex");
			const file = join(this.dir, blob);
			if (!existsSync(file)) {
				mkdirSync(this.dir, { recursive: true, mode: 0o700 });
				writeFileSync(file, bytes, { mode: 0o600 });
			}
			out.push({ path, existed: true, blob });
		}
		return out;
	}

	/** Put files back, newest change first, so each ends as it was before the earliest one. */
	restore(changes: FileBefore[][]): string[] {
		const restored = new Set<string>();
		for (const files of [...changes].reverse()) {
			for (const file of files) {
				if (file.existed && file.blob) {
					mkdirSync(dirname(file.path), { recursive: true });
					writeFileSync(file.path, readFileSync(join(this.dir, file.blob)));
				} else if (!file.existed) rmSync(file.path, { force: true });
				restored.add(file.path);
			}
		}
		return [...restored];
	}
}
