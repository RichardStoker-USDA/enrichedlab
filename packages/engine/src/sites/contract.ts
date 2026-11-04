// The lab contract: what a lab serves so EnrichedLab (and other clients) can use it the same way at every site. The
// JSON Schemas in contract/ are the source; docs/labs.md is the prose. A lab describes itself at
// GET /.well-known/enrichedlab-lab, and `el lab check <lab>` checks a lab against these schemas.

import bundleSchema from "../../../../contract/bundles.schema.json" with { type: "json" };
import containerSchema from "../../../../contract/container.schema.json" with { type: "json" };
import eventSchema from "../../../../contract/event.schema.json" with { type: "json" };
import guardSchema from "../../../../contract/guard.schema.json" with { type: "json" };
import labSchema from "../../../../contract/lab.schema.json" with { type: "json" };
import meSchema from "../../../../contract/me.schema.json" with { type: "json" };
import modelsSchema from "../../../../contract/models.schema.json" with { type: "json" };
import usageSchema from "../../../../contract/usage.schema.json" with { type: "json" };

/** The contract this client speaks. A lab on another major is refused; a newer minor ("2026-11.1") is fine. */
export const CONTRACT = "2026-11";
export const DESCRIPTOR_PATH = "/.well-known/enrichedlab-lab";

export const SCHEMAS = {
	lab: labSchema,
	me: meSchema,
	models: modelsSchema,
	bundles: bundleSchema,
	event: eventSchema,
	guard: guardSchema,
	usage: usageSchema,
	container: containerSchema,
} as const;

export type Endpoint = "models" | "mcp" | "bundles" | "events" | "guard" | "devices" | "containers" | "ports" | "attach" | "files" | "apps" | "signers" | "usage" | "agents";

export interface SandboxProfile {
	name: string;
	cpu: number;
	memory: string;
	gpu?: string;
	wall_minutes?: number;
	runtime_class?: string;
}

export interface LabDescriptor {
	contract: string;
	name: string;
	title: string;
	endpoints: Partial<Record<Endpoint, boolean>>;
	sign_in: { kind: string };
	policy?: { keep_data_inside?: boolean };
	support?: { url: string };
	docs?: { url: string };
	sandbox_profiles?: SandboxProfile[];
	conformance?: { foreign_scope?: string; data_tool?: { name: string; arguments?: Record<string, unknown> } };
}

/** Why this client can't use a lab on that contract, or undefined when it can. */
export function contractProblem(descriptor: LabDescriptor): string | undefined {
	const major = descriptor.contract.split(".")[0];
	if (major === CONTRACT) return undefined;
	return `${descriptor.title} speaks lab contract ${descriptor.contract}; this version of EnrichedLab speaks ${CONTRACT}. Update EnrichedLab (el update) or ask the lab.`;
}

type Schema = {
	type?: string;
	required?: string[];
	properties?: Record<string, Schema>;
	items?: Schema;
	enum?: unknown[];
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	not?: Schema;
	format?: string;
};

const typeOf = (value: unknown): string =>
	value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

/**
 * Check a value against one of the contract's schemas. Covers what contract/ uses (types, required, properties,
 * items, enum, pattern, lengths, minimum, not, date-time); returns one line per problem, empty when it fits.
 */
export function validate(schema: Schema, value: unknown, at = "$"): string[] {
	const problems: string[] = [];
	const actual = typeOf(value);
	if (schema.type && !(schema.type === actual || (schema.type === "number" && actual === "integer"))) return [`${at} is ${actual}, expected ${schema.type}`];
	if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} is ${JSON.stringify(value)}, expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${at} is shorter than ${schema.minLength}`);
		if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${at} is longer than ${schema.maxLength}`);
		if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${at} doesn't match ${schema.pattern}`);
		if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) problems.push(`${at} isn't a date and time`);
	}
	if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) problems.push(`${at} is below ${schema.minimum}`);
	if (schema.not && validate(schema.not, value, at).length === 0) problems.push(`${at} must not match ${JSON.stringify(schema.not)}`);
	if (actual === "object") {
		const object = value as Record<string, unknown>;
		for (const key of schema.required ?? []) if (!(key in object)) problems.push(`${at}.${key} is missing`);
		for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in object) problems.push(...validate(sub, object[key], `${at}.${key}`));
	}
	if (actual === "array" && schema.items) (value as unknown[]).forEach((item, i) => problems.push(...validate(schema.items!, item, `${at}[${i}]`)));
	return problems;
}

/** One row of `el lab check`. */
export interface CheckRow {
	row: string;
	status: "pass" | "fail" | "skip";
	detail?: string;
}

/** An event from the lab's stream, as the engine passes it on. */
export interface LabEvent {
	type: string;
	at: string;
	id: string;
	session?: string;
	text?: string;
	[key: string]: unknown;
}
