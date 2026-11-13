/**
 * "Take the tuning back" in the Receiver island: POST /api/tuner/:sourceId/take-back writes the held
 * centre and sample rate and ends a plain resume's hold (docs/API.md). Offered while the source's
 * `tuningUnproven` (GET /api/sources) is set, except under the causes the core always refuses.
 */
import type { TunerState } from "@wavekit/api-types"
import type { DataLayer } from "../../data/index.ts"
import { errorMessage, isApiError } from "../../data/index.ts"

/**
 * The causes under which the core refuses a take-back (409 TUNER_TAKE_BACK_BLOCKED: a relay client,
 * a scanner lease, another core; TUNER_CONTROL_EXTERNAL under external control): no action there.
 */
const REFUSED_CAUSES: ReadonlySet<string> = new Set([
	"relay-attached",
	"external-control",
	"scanner-lease",
	"lost-ownership",
])

/** Whether the island offers the action for this `tuningUnproven.cause`. */
export function offersTakeBack(cause: string): boolean {
	return !REFUSED_CAUSES.has(cause)
}

/** The 409 codes whose server message says what to do instead (shown as the core wrote it). */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
	"TUNER_TAKE_BACK_BLOCKED",
	"TUNER_NOTHING_HELD",
])

/**
 * Takes the tuning back; null on success (the tuner state is the core's answer, the source row is
 * read again so its `tuningUnproven` clears), else the text to show. Never rejects.
 */
export async function takeTuningBack(
	data: Pick<DataLayer, "api" | "tuner" | "sources">,
	sourceId: string,
): Promise<string | null> {
	try {
		const state = await data.api.post<TunerState>(
			`/api/tuner/${encodeURIComponent(sourceId)}/take-back`,
		)
		data.tuner.receive(state)
		void data.sources.load()
		return null
	} catch (error) {
		if (
			isApiError(error) &&
			error.code !== null &&
			REFUSAL_CODES.has(error.code)
		)
			return error.message
		return `Could not take the tuning back: ${errorMessage(error)}`
	}
}
