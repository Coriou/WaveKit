/** Zod schema of the persisted per-source engine state (spec § 8 `engine/<sourceId>.json`). */
import { z } from "zod"
import type { Assert, EngineState, SchemaMatches } from "./types.js"

export const EngineStateSchema = z.object({
	version: z.literal(1),
	absoluteFloors: z.array(z.object({ key: z.string(), dbfs: z.number() })),
	spurs: z.array(
		z.object({
			key: z.string(),
			basebandBin: z.number().int(),
			widthBins: z.number().int().positive(),
			kind: z.enum(["baseband", "rf"]),
			rfHz: z.number().optional(),
		}),
	),
	kByRange: z.array(
		z.object({ startHz: z.number(), endHz: z.number(), k: z.number() }),
	),
	provisionalSpurs: z
		.array(
			z.object({
				key: z.string(),
				basebandBin: z.number().int().nonnegative(),
				widthBins: z.number().int().positive(),
				comb: z.boolean(),
			}),
		)
		.optional(), // Task 7a; absent in files written before it
})
export type EngineStateCheck = Assert<
	SchemaMatches<EngineState, typeof EngineStateSchema>
>
