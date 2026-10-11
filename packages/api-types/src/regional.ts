/** Read-only advisory display data; no receiver or regulatory permission. */
export type RegionalRegionCode = "EU" | "US" | "CA" | "AU" | "NZ" | "JP" | "CN"
export interface RegionalApplicability {
	readonly kind: "national"
	readonly countryCode: "US"
}
export interface RegionalCoarseContext {
	readonly code: RegionalRegionCode
	readonly source:
		| "configured"
		| "decoder"
		| "guessed:tz"
		| "guessed:intl-timezone"
		| "guessed:locale-env"
		| "guessed:intl-locale"
		| "default"
}
export interface RegionalSelection {
	readonly requestedRegion: RegionalRegionCode
	readonly source: "query"
	readonly coarseContext: RegionalCoarseContext | null
}
export type RegionalFrequency =
	| { readonly kind: "simplex"; readonly frequencyHz: number }
	| {
			readonly kind: "duplex"
			readonly stationReceiveHz: number
			readonly stationTransmitHz: number
			readonly endpoint: "subscriber" | "base"
	}
export interface RegionalSourceReference {
	readonly id: string
	readonly organization: string
	readonly documentId: string
	readonly title: string
	readonly edition: string
	readonly publishedDate: string | null
	readonly retrievedDate: string
	readonly url: string
	readonly documentSha256: string
	readonly applicability: "US"
	readonly redistribution: "facts-transcribed"
	readonly locator: string
}
export interface RegionalChannelRow {
	readonly id: string
	readonly displayLabel: string
	readonly aliases: readonly string[]
	readonly frequency: RegionalFrequency
	readonly display: {
		readonly advisory: true
		readonly mode: "nfm" | "fm" | "am" | "digital" | "unknown" | null
		readonly bandwidthHz: number | null
		readonly stepHz: number | null
	}
	readonly sourceReferenceIds: readonly string[]
}
export type RegionalFamilyManifest = {
	readonly familyId: "frs"
	readonly displayLabel: string
	readonly applicability: RegionalApplicability
} & (
	| {
			readonly state: "unavailable"
			readonly datasetVersion: null
			readonly reason: "evidence-pending"
	}
	| {
			readonly state: "verified"
			readonly datasetVersion: string
			readonly reason: null
	}
)
export interface RegionalDatasetHeader {
	readonly datasetId: "us-frs"
	readonly datasetVersion: string
	readonly dataContentSha256: string
	readonly applicability: RegionalApplicability
	readonly verifiedAsOf: string
	readonly sourceReferences: readonly RegionalSourceReference[]
}
export interface RegionalDataset extends RegionalDatasetHeader {
	readonly schemaVersion: 1
	readonly familyId: "frs"
	readonly rows: readonly RegionalChannelRow[]
}
export type RegionalFamiliesResult = {
	readonly schemaVersion: 1
	readonly selection: RegionalSelection
} & (
	| {
			readonly state: "available"
			readonly families: readonly [RegionalFamilyManifest]
	}
	| {
			readonly state: "unsupported"
			readonly reason: "region-not-covered"
			readonly families: readonly []
	}
)
export type RegionalUnavailableResult = {
	readonly schemaVersion: 1
	readonly selection: RegionalSelection
	readonly familyId: "frs"
} & (
	| { readonly state: "unavailable"; readonly reason: "evidence-pending" }
	| { readonly state: "unsupported"; readonly reason: "region-not-covered" }
)
export type RegionalChannelsResult =
	| RegionalUnavailableResult
	| {
			readonly schemaVersion: 1
			readonly selection: RegionalSelection
			readonly state: "verified"
			readonly dataset: RegionalDatasetHeader
			readonly total: number
			readonly offset: number
			readonly limit: number
			readonly rows: readonly RegionalChannelRow[]
			readonly nextOffset: number | null
	}
export type RegionalResolveResult =
	| RegionalUnavailableResult
	| ({
			readonly schemaVersion: 1
			readonly selection: RegionalSelection
			readonly state: "verified"
			readonly dataset: RegionalDatasetHeader
			readonly normalizedAlias: string
	} & (
			| {
					readonly result: "matched"
					readonly candidates: readonly [RegionalChannelRow]
			}
			| {
					readonly result: "ambiguous"
					readonly candidates: readonly [
						RegionalChannelRow,
						RegionalChannelRow,
						...RegionalChannelRow[],
					]
			}
			| { readonly result: "not-found"; readonly candidates: readonly [] }
	))

export type RegionalErrorResponse =
	| {
			readonly error: "Bad Request"
			readonly code: "REGIONAL_INVALID_REQUEST"
			readonly message: "Invalid regional registry request"
	}
	| {
			readonly error: "Method Not Allowed"
			readonly code: "REGIONAL_METHOD_NOT_ALLOWED"
			readonly message: "Regional registry method is not allowed"
	}
	| {
			readonly error: "Service Unavailable"
			readonly code: "REGIONAL_UNAVAILABLE"
			readonly message: "Regional registry is unavailable"
	}
	| {
			readonly error: "Not Found"
			readonly code: "REGIONAL_FAMILY_NOT_FOUND"
			readonly message: "Regional family not found"
	}
