// Moving a git repository between the person's computer and a lab sandbox as git bundles. The send carries
// uncommitted work (secret-looking files stay behind); the fetch brings new sandbox commits back as a local branch.
// Used by the sandbox repo tools and when a session moves to a lab with its work.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fetchBundle, identity, packForSend } from "../git.ts";
import { type SandboxApi, shq } from "./sandbox_workspace.ts";

export interface Sent {
	/** The local repository. */
	repo: string;
	/** The commit sent: new work in the sandbox is everything after it. */
	base: string;
	/** Short id, used in the folder and branch names. */
	id: string;
	skipped: string[];
}

/** Send `repo` into the sandbox folder `dir` on branch work. */
export async function sendRepo(api: SandboxApi, repo: string, dir: string, signal?: AbortSignal): Promise<Sent & { head: string }> {
	const scratch = await mkdtemp(join(tmpdir(), "enriched-send-"));
	try {
		const bundle = join(scratch, `${basename(repo)}.bundle`);
		const pack = packForSend(repo, bundle);
		const who = identity(repo);
		const placed = await api.put(bundle, signal);
		const unpack = [
			"set -e",
			`mkdir -p ${shq(dir)}`,
			`cd ${shq(dir)}`,
			"git init -q . 2>/dev/null || true",
			`git fetch -q ${shq(placed.path)} ${pack.ref}:refs/heads/work`,
			"git checkout -q -f work",
			// Commits made there are the person's.
			`git config user.name ${shq(who.name)}`,
			`git config user.email ${shq(who.email)}`,
			`rm -f ${shq(placed.path)}`,
			"git log --oneline -1",
		].join("; ");
		const result = await api.run(unpack, 300, signal);
		if (result.exitCode !== 0) throw new Error(`The ${api.title} sandbox couldn't unpack the repository: ${result.stderr || result.stdout}`);
		return { repo, base: pack.commit, id: pack.id, skipped: pack.skipped, head: result.stdout.trim() };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Commit what's left in `dir` (as the person) and fetch commits after `sent.base` as local `branch`. */
export async function fetchRepo(api: SandboxApi, dir: string, sent: Pick<Sent, "repo" | "base">, branch: string, signal?: AbortSignal): Promise<string[]> {
	if (!/^[0-9a-f]{7,64}$/.test(sent.base)) throw new Error("The record of what was sent is damaged.");
	const who = identity(sent.repo);
	const out = `/sandbox/out/${basename(dir)}-${randomBytes(3).toString("hex")}.bundle`;
	const pack = [
		"set -e",
		`cd ${shq(dir)}`,
		"git add -A",
		`if ! git diff --cached --quiet; then git -c user.name=${shq(who.name)} -c user.email=${shq(who.email)} commit -q -m ${shq(`Work from the ${api.title} sandbox`)}; fi`,
		`if [ "$(git rev-list --count ${sent.base}..work)" = 0 ]; then echo nothing-new; exit 0; fi`,
		"mkdir -p /sandbox/out",
		`git bundle create -q ${shq(out)} ${sent.base}..work`,
	].join("; ");
	const result = await api.run(pack, 300, signal);
	if (result.exitCode !== 0) throw new Error(`The ${api.title} sandbox couldn't pack the work: ${result.stderr || result.stdout}`);
	if (result.stdout.includes("nothing-new")) return [];
	const scratch = await mkdtemp(join(tmpdir(), "enriched-fetch-"));
	try {
		const local = join(scratch, "work.bundle");
		await api.get(out, local, signal);
		const commits = fetchBundle(sent.repo, local, "refs/heads/work", branch, sent.base);
		await api.run(`rm -f ${shq(out)}`, 30).catch(() => undefined);
		return commits;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
