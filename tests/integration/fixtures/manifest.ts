import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { z } from "zod"

export const CONTAINER_SAFE_ID = /^[a-z0-9][a-z0-9_]*$/
const Sha256 = z
	.string()
	.regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex")
const FixtureId = z.string().regex(CONTAINER_SAFE_ID)

export const FixtureRoleSchema = z.enum([
	"channelizer-golden",
	"tail-golden",
	"parser-transcript",
	"negative",
])
export const FixtureFormatSchema = z.enum(["cu8", "cs16", "cf32", "wav"])

const FetchSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("public"),
			url: z.string().url(),
			archive_sha256: Sha256,
			member: z.string().min(1).optional(),
			transform: z.enum(["none", "wav-to-cu8"]).default("none"),
		})
		.strict(),
	z.object({ kind: z.literal("private") }).strict(),
])

const ExpectedSchema = z
	.object({
		min_count: z.number().int().nonnegative(),
		payloads: z.array(z.record(z.unknown())).default([]),
		key_fields: z.array(z.string().min(1)).min(1).optional(),
		output_types: z.array(z.string().min(1)).min(1).optional(),
		suspension: z.literal("channel-outside-capture").optional(),
	})
	.strict()

export const FixtureSchema = z
	.object({
		id: FixtureId,
		role: FixtureRoleSchema,
		decoder: z.string().min(1),
		decoder_options: z.record(z.unknown()).default({}),
		license: z.string().min(1),
		provenance: z
			.object({ url: z.string().url().optional(), notes: z.string().min(1) })
			.strict(),
		fetch: FetchSchema,
		file: z.string().regex(/^raw\/[A-Za-z0-9._-]+$/),
		sha256: Sha256,
		format: FixtureFormatSchema,
		sample_rate: z.number().int().positive(),
		center_hz: z.number().positive().optional(),
		duration_s: z.number().positive(),
		playback_speed: z.number().positive().max(4).default(1),
		large: z.boolean().default(false),
		expected: ExpectedSchema,
		channel: z.object({ center_hz: z.number().positive() }).strict().optional(),
	})
	.strict()
	.superRefine((f, ctx) => {
		const issue = (message: string) =>
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${f.id}: ${message}`,
			})
		if (f.role === "channelizer-golden") {
			if (
				f.format !== "cu8" ||
				f.sample_rate < 2_048_000 ||
				f.center_hz === undefined
			)
				issue("a channelizer golden needs cu8 at >= 2048000 Hz with center_hz")
			if (!f.expected.key_fields)
				issue("a channelizer golden needs expected.key_fields")
			if (f.expected.min_count < 1)
				issue("a channelizer golden needs min_count >= 1")
		}
		if (f.role === "negative" && f.expected.min_count !== 0)
			issue("negative fixtures expect min_count 0")
		if (f.expected.suspension && f.role !== "negative")
			issue("expected.suspension is for negative fixtures")
		if ((f.license === "private") !== (f.fetch.kind === "private"))
			issue("license 'private' iff fetch.kind 'private'")
	})

export const CandidateSchema = z
	.object({
		id: FixtureId,
		decoder: z.string().min(1),
		url: z.string().url().nullable(),
		license: z.string().min(1).nullable(),
		blockers: z.array(z.string().min(1)).min(1),
		notes: z.string().optional(),
	})
	.strict()

export const ManifestSchema = z
	.object({
		version: z.literal(2),
		fixtures: z.array(FixtureSchema),
		candidates: z.array(CandidateSchema).default([]),
	})
	.strict()
	.superRefine((m, ctx) => {
		const seen = new Set<string>()
		for (const id of [
			...m.fixtures.map(f => f.id),
			...m.candidates.map(c => c.id),
		]) {
			if (seen.has(id))
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `duplicate id ${id}`,
				})
			seen.add(id)
		}
	})

export type Fixture = z.infer<typeof FixtureSchema>
export type Manifest = z.infer<typeof ManifestSchema>

export function parseManifest(text: string): Manifest {
	return ManifestSchema.parse(parse(text))
}

export function loadManifest(path = "fixtures/manifest.yaml"): Manifest {
	return parseManifest(readFileSync(path, "utf8"))
}
