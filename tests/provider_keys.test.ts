import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyAccount } from "../packages/engine/src/models/providers.ts";

describe("provider key accounts", () => {
	test("the usual home keeps the plain name its keys were saved under", () => {
		expect(keyAccount(join(homedir(), ".el", "credentials"), "openai")).toBe("provider:openai");
		expect(keyAccount(join(homedir(), ".enriched", "credentials"), "openai")).toBe("provider:openai");
	});
	test("another home gets its own entry, the same each time", () => {
		const other = keyAccount("/tmp/el-test-home/credentials", "openai");
		expect(other).toMatch(/^provider:openai@[0-9a-f]{12}$/);
		expect(keyAccount("/tmp/el-test-home/credentials", "openai")).toBe(other);
		expect(keyAccount("/tmp/el-other-home/credentials", "openai")).not.toBe(other);
	});
});
