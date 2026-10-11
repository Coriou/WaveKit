import { validateRegistration } from "./types.js"
import type { CoarseContext, Registration } from "./types.js"

/** No numerical publication is accepted. Context never supplies data authority. */
export function createRegionalRegistration(
	coarseContext: Readonly<CoarseContext> | null = null,
): Registration {
	return validateRegistration({
		schemaVersion: 1,
		registrations: [
			{
				manifest: {
					familyId: "frs",
					displayLabel: "FRS",
					applicability: { kind: "national", countryCode: "US" },
					state: "unavailable",
					datasetVersion: null,
					reason: "evidence-pending",
				},
				dataset: null,
			},
		],
		coarseContext,
	})
}
export const REGIONAL_REGISTRATION = createRegionalRegistration()
