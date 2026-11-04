// The harness benchmark: fixed tasks (bench/scenarios/*.json) run end to end through the engine on one model, each
// in a fresh scratch project, then checked. Run before a change reaches the stable channel and compare runs.
//
//   bun scripts/bench.ts [--model <ref>] [scenario-file-name ...]
//
// A scenario: { name, files: {path: text}, prompt, checks: [...] }. Checks:
//   { "run": "command" }                          exits 0 in the project
//   { "file": "path", "contains": "text" }        the file contains the text
//   { "file": "path", "unchanged": true }         the file is as the scenario wrote it
//   { "answer": "text" }                          the last answer contains the text
//   { "opened": "app-name" }                      the agent opened that app
// Results go to dist/bench/<time>.json and a line per scenario to stdout.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionEvent } from "../packages/protocol/src/index.ts";
import { EngineClient, ensureEngine } from "../packages/engine/src/index.ts";

type Check = { run?: string; file?: string; contains?: string; unchanged?: boolean; answer?: string; opened?: string };
interface Scenario {
	name: string;
	files: Record<string, string>;
	prompt: string;
	checks: Check[];
	timeout?: number;
}

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const modelAt = args.indexOf("--model");
const model = modelAt >= 0 ? args.splice(modelAt, 2)[1] : undefined;
const dir = join(root, "bench", "scenarios");
const picked = readdirSync(dir).filter((f) => f.endsWith(".json") && (!args.length || args.some((a) => f.includes(a))));

const client = new EngineClient(await ensureEngine(), "bench");
await client.ready();
const results: Record<string, unknown>[] = [];

for (const file of picked) {
	const scenario = JSON.parse(readFileSync(join(dir, file), "utf8")) as Scenario;
	const project = mkdtempSync(join(tmpdir(), "enrichedlab-bench-"));
	for (const [path, text] of Object.entries(scenario.files)) {
		mkdirSync(dirname(join(project, path)), { recursive: true });
		writeFileSync(join(project, path), text);
	}
	execSync("git init -q -b main && git add . && git -c user.email=bench@localhost -c user.name=bench commit -qm start", { cwd: project });
	const started = Date.now();
	const session = await client.call("session.create", { cwd: project, model });
	await client.call("session.open", { sessionId: session.id });
	const opened: string[] = [];
	const offAsk = client.on("permission.request", (r) => void client.call("permission.answer", { requestId: r.requestId, decision: "allow" }));
	const offApp = client.on("app.opened", (o) => o.sessionId === session.id && opened.push(o.app.name));
	await client.call("session.prompt", { sessionId: session.id, text: scenario.prompt });
	const finished = await Promise.race([
		new Promise<boolean>((done) => client.on("session.status", (s) => s.sessionId === session.id && s.activity === "idle" && done(true))),
		new Promise<boolean>((done) => setTimeout(() => done(false), (scenario.timeout ?? 300) * 1000)),
	]);
	offAsk();
	offApp();
	if (!finished) await client.call("session.cancel", { sessionId: session.id }).catch(() => undefined);
	const { events, status } = await client.call("session.open", { sessionId: session.id });
	const answers = events.filter((e): e is Extract<SessionEvent, { t: "assistant" }> => e.t === "assistant");
	const answer = answers.at(-1)?.text ?? "";
	const failed: string[] = [];
	for (const check of scenario.checks) {
		const where = check.file ? join(project, check.file) : "";
		const text = (() => {
			try {
				return where ? readFileSync(where, "utf8") : "";
			} catch {
				return undefined;
			}
		})();
		if (check.run) {
			try {
				execSync(check.run, { cwd: project, stdio: "ignore", timeout: 60_000 });
			} catch {
				failed.push(`run ${check.run}`);
			}
		} else if (check.unchanged && text !== scenario.files[check.file!]) failed.push(`${check.file} changed`);
		else if (check.contains !== undefined && !text?.includes(check.contains)) failed.push(`${check.file} lacks ${check.contains}`);
		else if (check.answer !== undefined && !answer.includes(check.answer)) failed.push(`answer lacks ${check.answer}`);
		else if (check.opened !== undefined && !opened.includes(check.opened)) failed.push(`didn't open ${check.opened}`);
	}
	const result = {
		scenario: scenario.name,
		passed: finished && !failed.length,
		failed: finished ? failed : ["timed out", ...failed],
		seconds: Math.round((Date.now() - started) / 100) / 10,
		steps: events.filter((e) => e.t === "tool").length,
		model: status.model,
		contextTokens: status.context?.used,
	};
	results.push(result);
	console.log(`${result.passed ? "pass" : "FAIL"}  ${scenario.name}  ${result.seconds}s  ${result.steps} steps${result.failed.length ? `  (${result.failed.join("; ")})` : ""}`);
	await client.call("session.delete", { sessionId: session.id }).catch(() => undefined);
	rmSync(project, { recursive: true, force: true });
}

const passed = results.filter((r) => r.passed).length;
console.log(`${passed}/${results.length} passed`);
mkdirSync(join(root, "dist", "bench"), { recursive: true });
writeFileSync(join(root, "dist", "bench", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
client.close();
process.exit(passed === results.length ? 0 : 1);
