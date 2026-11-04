// Git for sessions: a worktree and branch per writing agent, so parallel agents never touch the person's checkout,
// and turn snapshots as commits on a hidden ref, so undo covers shell changes too. Every command here leaves the
// person's index, branch and history alone. See docs/bundles.md.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_NAME } from "./util.ts";

function git(cwd: string, args: string[], env?: Record<string, string>): string {
	return execFileSync("git", args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The repository's top folder, or undefined outside git. */
export function repoRoot(cwd: string): string | undefined {
	try {
		return git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return undefined;
	}
}

/** A branch name from a session title: lowercase words joined by dashes, under the enriched/ prefix. */
export function branchFor(sessionId: string, title: string): string {
	const words = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
	return `enriched/${words || "session"}-${sessionId.slice(-6)}`;
}

/** Create a worktree on a new branch from the current HEAD. Returns its folder and branch. */
export function createWorktree(root: string, sessionId: string, title: string): { path: string; branch: string } {
	const dir = join(root, ".git", "enriched-worktrees");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, sessionId);
	const branch = branchFor(sessionId, title);
	git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
	return { path, branch };
}

/** Remove a worktree the engine made; refuses folders it didn't make. The branch stays unless `dropBranch`. */
export function removeWorktree(root: string, path: string, branch?: string, dropBranch = false): void {
	if (!path.includes(join(".git", "enriched-worktrees"))) throw new Error(`${path} isn't a worktree EnrichedLab made.`);
	git(root, ["worktree", "remove", "--force", path]);
	if (dropBranch && branch) git(root, ["branch", "-D", branch]);
}

/**
 * Snapshot the working tree (tracked and untracked, honoring .gitignore) as a commit on
 * refs/enriched/checkpoints/<session>, through a temporary index so the person's staging area is untouched.
 * Returns the commit id.
 */
export function snapshot(cwd: string, sessionId: string, message: string): string {
	const scratch = mkdtempSync(join(tmpdir(), "enriched-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		git(cwd, ["add", "-A", "."], env);
		const tree = git(cwd, ["write-tree"], env);
		const ref = `refs/enriched/checkpoints/${sessionId}`;
		let parent: string | undefined;
		try {
			parent = git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
		} catch {
			parent = undefined;
		}
		const commit = git(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], {
			GIT_AUTHOR_NAME: "EnrichedLab",
			GIT_AUTHOR_EMAIL: "checkpoints@enrichedlab.invalid",
			GIT_COMMITTER_NAME: "EnrichedLab",
			GIT_COMMITTER_EMAIL: "checkpoints@enrichedlab.invalid",
		});
		git(cwd, ["update-ref", ref, commit]);
		return commit;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Put the working tree back to a snapshot: changed files restored, files created since removed. Index untouched. */
export function restoreSnapshot(cwd: string, commit: string): string[] {
	const now = snapshot(cwd, "restore-scratch", "before restore");
	const changed = git(cwd, ["diff", "--name-only", commit, now]).split("\n").filter(Boolean);
	if (changed.length) {
		const scratch = mkdtempSync(join(tmpdir(), "enriched-index-"));
		try {
			const env = { GIT_INDEX_FILE: join(scratch, "index") };
			git(cwd, ["read-tree", commit], env);
			git(cwd, ["checkout-index", "-a", "-f"], env);
			for (const file of changed) {
				const inTarget = git(cwd, ["ls-tree", "--name-only", commit, "--", file]);
				if (!inTarget && existsSync(join(cwd, file))) rmSync(join(cwd, file), { force: true });
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	git(cwd, ["update-ref", "-d", "refs/enriched/checkpoints/restore-scratch"]);
	return changed;
}

/** The person's git identity, so work made elsewhere is committed as theirs. */
export function identity(cwd: string): { name: string; email: string } {
	const read = (key: string) => {
		try {
			return git(cwd, ["config", key]);
		} catch {
			return "";
		}
	};
	return { name: read("user.name") || "EnrichedLab", email: read("user.email") || "enrichedlab@localhost" };
}

/**
 * The repository as it is now, ready to send elsewhere: HEAD plus one commit holding uncommitted and untracked
 * (not ignored) files, with secret-looking files left out. Kept on refs/enriched/send/<id>; the person's index and
 * branch are untouched. Writes a bundle of that ref to `bundle`.
 */
export function packForSend(repo: string, bundle: string): { id: string; ref: string; commit: string; skipped: string[] } {
	const id = randomBytes(4).toString("hex");
	const ref = `refs/enriched/send/${id}`;
	const scratch = mkdtempSync(join(tmpdir(), "enriched-index-"));
	try {
		const env = { GIT_INDEX_FILE: join(scratch, "index") };
		let head: string | undefined;
		try {
			head = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
		} catch {
			head = undefined;
		}
		if (head) git(repo, ["read-tree", head], env);
		git(repo, ["add", "-A", "."], env);
		const files = git(repo, ["ls-files", "--cached"], env).split("\n").filter(Boolean);
		const skipped = files.filter((f) => SECRET_NAME.test(f));
		for (const file of skipped) git(repo, ["rm", "--cached", "-q", "--", file], env);
		const tree = git(repo, ["write-tree"], env);
		const headTree = head ? git(repo, ["rev-parse", `${head}^{tree}`]) : "";
		const who = identity(repo);
		const as = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
		// A clean tree sends HEAD itself; otherwise one commit on top carries the uncommitted work.
		const commit = head && tree === headTree ? head : git(repo, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "Uncommitted work"], as);
		git(repo, ["update-ref", ref, commit]);
		git(repo, ["bundle", "create", "-q", bundle, ref]);
		return { id, ref, commit, skipped };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Bring commits from a bundle in as a new local branch and list the ones after `base`. Nothing else changes. */
export function fetchBundle(repo: string, bundle: string, source: string, branch: string, base: string): string[] {
	git(repo, ["fetch", "-q", bundle, `${source}:refs/heads/${branch}`]);
	return git(repo, ["log", "--format=%h %s", `${base}..${branch}`]).split("\n").filter(Boolean);
}

/** Files that differ between a snapshot and the working tree now. Nothing in the repository changes. */
export function changedSince(cwd: string, commit: string): string[] {
	const now = snapshot(cwd, "compare-scratch", "now");
	try {
		return git(cwd, ["diff", "--name-only", commit, now]).split("\n").filter(Boolean);
	} finally {
		git(cwd, ["update-ref", "-d", "refs/enriched/checkpoints/compare-scratch"]);
	}
}
