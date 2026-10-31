/**
 * ACARS label table: what a two-character label says about a message, in plain language, with
 * how sure WaveKit is and where that comes from. The label itself stays in the message; this
 * table only explains it.
 *
 * ARINC 618/620/622/623 define the labels, but those specifications are not public. An entry is
 * kept only when:
 *   - libacars decodes that label's payload (basis "standard"), or
 *   - a public label list names it and no other source names it differently (basis "listed"),
 *     or the list says the airline defines it (basis "airline").
 * Labels where public sources disagree (10, 11, 16, 20, 21) are left out on purpose: a wrong
 * explanation is worse than none. See docs/AIRCRAFT-DATALINK.md for the source list.
 */

/** What a message is about. "link" and "ground-station" are technical traffic. */
export type AcarsLabelFamily =
	| "link"
	| "ground-station"
	| "air-traffic"
	| "airline"
	| "onboard"
	| "weather"
	| "maintenance"

/**
 * How WaveKit knows the meaning:
 * - standard: the payload follows a published standard that libacars decodes;
 * - listed: named by a public label list, the text format is not public;
 * - airline: reserved for the airline's own use, the airline defines the content.
 */
export type AcarsLabelBasis = "standard" | "listed" | "airline"

/** Sources, cited by id. Revisions are the ones pinned in the Dockerfile or checked. */
export const ACARS_LABEL_SOURCES = {
	libacars:
		"libacars 2.2.1 (szpajder/libacars @9af09a0), acars.c la_acars_apps_parse_and_reassemble: labels decoded as ARINC 622, MIAM, OHMA and media advisory",
	acarsdec:
		"acarsdec (f00b4r0/acarsdec @206f733), output.c prints label _DEL as _d; label.c decodes OOOI and ETA fields of the Q labels",
	acarshub:
		"ACARS Hub label metadata (sdr-enthusiasts/docker-acarshub, rootfs/webapp/data/metadata.json, GPL-3.0, attributed to Airframes.io)",
	acarsDecoder:
		"@airframes/acars-decoder 1.9.5 (MIT), plugin names; used to find labels whose public names disagree",
} as const

export type AcarsLabelSource = keyof typeof ACARS_LABEL_SOURCES

export interface AcarsLabelInfo {
	/** The label as acarsdec and libacars print it (`_d` for _DEL). */
	label: string
	/** Plain-language name. */
	name: string
	family: AcarsLabelFamily
	basis: AcarsLabelBasis
	sources: readonly AcarsLabelSource[]
	/** One line a user can read when the name alone is not enough. */
	note?: string
}

type Row = [
	label: string,
	name: string,
	family: AcarsLabelFamily,
	basis: AcarsLabelBasis,
	sources: readonly AcarsLabelSource[],
	note?: string,
]

const OOOI_NOTE =
	"Flight event report: Out of the gate, Off the ground, On the ground, In at the gate. The airline sets the text format."
const ATS_NOTE =
	"Air traffic services message (ARINC 623 family). The text is readable but its layout varies."
const ARINC622_NOTE =
	"libacars reads the actual application (ADS-C or CPDLC) from the message itself."

const ROWS: readonly Row[] = [
	// Link management: technical traffic.
	[
		"_d",
		"No information to transmit",
		"link",
		"listed",
		["acarsdec", "acarshub"],
		"An acknowledgement that keeps the link open. It carries no text.",
	],
	["Q0", "Link test", "link", "listed", ["acarshub"]],
	[
		"SA",
		"Media advisory",
		"link",
		"standard",
		["libacars", "acarshub"],
		"Says which links (VHF, VDL2, satellite, HF) the aircraft can use now.",
	],
	[
		":;",
		"Change transceiver frequency",
		"link",
		"listed",
		["acarshub"],
		"The ground tells the aircraft's data radio to move to another frequency.",
	],
	["F3", "Dedicated transceiver advisory", "link", "listed", ["acarshub"]],
	["HX", "Undelivered uplink report", "link", "listed", ["acarshub"]],
	["QX", "Intercept or unable to process", "link", "listed", ["acarshub"]],
	[
		"SQ",
		"Ground station squitter",
		"ground-station",
		"listed",
		["acarshub", "acarsDecoder"],
		"A ground station announcing itself, its network and position. Not sent by an aircraft.",
	],
	// Payloads libacars decodes.
	[
		"H1",
		"Message to or from an onboard system",
		"onboard",
		"listed",
		["libacars", "acarshub"],
		"Routed by its sublabel to a system such as the flight management computer or the printer. libacars decodes some of them; most use the airline's or the avionics maker's own format.",
	],
	[
		"MA",
		"Compressed message (MIAM)",
		"onboard",
		"standard",
		["libacars"],
		"A message compressed for transport; libacars unpacks it.",
	],
	[
		"AA",
		"ATC message (CPDLC)",
		"air-traffic",
		"standard",
		["libacars", "acarshub"],
		ARINC622_NOTE,
	],
	[
		"BA",
		"ATC message (CPDLC)",
		"air-traffic",
		"standard",
		["libacars", "acarshub"],
		ARINC622_NOTE,
	],
	[
		"A6",
		"ADS-C request",
		"air-traffic",
		"standard",
		["libacars", "acarshub"],
		ARINC622_NOTE,
	],
	[
		"B6",
		"ADS-C report",
		"air-traffic",
		"standard",
		["libacars", "acarshub"],
		ARINC622_NOTE,
	],
	// Air traffic services over ACARS.
	[
		"B0",
		"ATS facility notification",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	["A1", "Oceanic clearance", "air-traffic", "listed", ["acarshub"], ATS_NOTE],
	[
		"A2",
		"Departure clearance",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	[
		"A3",
		"Departure clearance",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	[
		"A4",
		"Departure clearance acknowledged",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	[
		"A5",
		"Position report request",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	["A7", "Free text from ATC", "air-traffic", "listed", ["acarshub"], ATS_NOTE],
	["A8", "Departure slot", "air-traffic", "listed", ["acarshub"], ATS_NOTE],
	["A9", "ATIS information", "air-traffic", "listed", ["acarshub"], ATS_NOTE],
	[
		"B1",
		"Oceanic clearance request",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	[
		"B2",
		"Oceanic clearance readback",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	[
		"B3",
		"Departure clearance request",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	[
		"B4",
		"Departure clearance readback",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	[
		"B5",
		"Waypoint position report",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	["B7", "Free text to ATC", "air-traffic", "listed", ["acarshub"], ATS_NOTE],
	[
		"B8",
		"Departure slot request",
		"air-traffic",
		"listed",
		["acarshub"],
		ATS_NOTE,
	],
	["B9", "ATIS request", "air-traffic", "listed", ["acarshub"], ATS_NOTE],
	["5D", "ATIS request", "air-traffic", "listed", ["acarshub"]],
	// Weather.
	["5U", "Weather request", "weather", "listed", ["acarshub"]],
	["24", "Weather request", "weather", "listed", ["acarshub"]],
	["H2", "Weather report", "weather", "listed", ["acarshub"]],
	// Flight events (OOOI) and estimates: listed names, airline formats.
	[
		"QA",
		"Out of the gate, with fuel",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
		OOOI_NOTE,
	],
	[
		"QB",
		"Off the ground",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
		OOOI_NOTE,
	],
	[
		"QC",
		"On the ground",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
		OOOI_NOTE,
	],
	[
		"QD",
		"In at the gate, with fuel",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
		OOOI_NOTE,
	],
	[
		"QE",
		"Out of the gate, with fuel and destination",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
		OOOI_NOTE,
	],
	[
		"QF",
		"Off the ground, with destination",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
		OOOI_NOTE,
	],
	[
		"QG",
		"Out of the gate, returned to it",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
		OOOI_NOTE,
	],
	[
		"QH",
		"Out of the gate",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
		OOOI_NOTE,
	],
	["QK", "Landing report", "airline", "listed", ["acarshub"], OOOI_NOTE],
	["QL", "Arrival report", "airline", "listed", ["acarshub"], OOOI_NOTE],
	["QM", "Arrival information", "airline", "listed", ["acarshub"]],
	["QN", "Diversion report", "airline", "listed", ["acarshub"]],
	["QP", "Out of the gate", "airline", "listed", ["acarshub"], OOOI_NOTE],
	["QQ", "Off the ground", "airline", "listed", ["acarshub"], OOOI_NOTE],
	["QR", "On the ground", "airline", "listed", ["acarshub"], OOOI_NOTE],
	["QS", "In at the gate", "airline", "listed", ["acarshub"], OOOI_NOTE],
	[
		"Q1",
		"Departure or arrival estimate",
		"airline",
		"listed",
		["acarshub", "acarsdec"],
	],
	["Q2", "Arrival estimate", "airline", "listed", ["acarshub", "acarsdec"]],
	["1M", "Arrival estimate", "airline", "listed", ["acarshub"]],
	["4T", "Arrival estimate", "airline", "listed", ["acarshub", "acarsDecoder"]],
	["5Y", "Estimate revised or diversion", "airline", "listed", ["acarshub"]],
	["30", "Position report", "airline", "listed", ["acarshub"]],
	["5R", "Position report", "airline", "listed", ["acarshub"]],
	["54", "Crew asks for a voice call", "airline", "listed", ["acarshub"]],
	["7B", "Crew message", "airline", "listed", ["acarshub"]],
	["C1", "Cockpit printer message", "airline", "listed", ["acarshub"]],
	["7A", "Engine data", "maintenance", "listed", ["acarshub"]],
	// Reserved for the airline.
	["5Z", "Airline message", "airline", "airline", ["acarshub"]],
	["80", "Airline message", "airline", "airline", ["acarshub"]],
	["83", "Airline message", "airline", "airline", ["acarshub"]],
	["8D", "Airline message", "airline", "airline", ["acarshub"]],
	["8E", "Airline message", "airline", "airline", ["acarshub"]],
]

const TABLE: ReadonlyMap<string, AcarsLabelInfo> = new Map(
	ROWS.map(([label, name, family, basis, sources, note]) => [
		label,
		note === undefined
			? { label, name, family, basis, sources }
			: { label, name, family, basis, sources, note },
	]),
)

/** Every entry, in table order (for docs and tests). */
export function acarsLabelEntries(): readonly AcarsLabelInfo[] {
	return [...TABLE.values()]
}

/**
 * The label as printed, with the DEL character (0x7F) of `_DEL` written as `d` the way acarsdec
 * does, so both decoders agree. Undefined for anything that is not two characters.
 */
export function normalizeAcarsLabel(
	raw: string | undefined,
): string | undefined {
	if (raw === undefined) return undefined
	const label = raw.replace(/\u007f/g, "d")
	return label.length === 2 ? label : undefined
}

/** The table entry for a label, or undefined when WaveKit does not explain it. */
export function acarsLabelInfo(
	raw: string | undefined,
): AcarsLabelInfo | undefined {
	const label = normalizeAcarsLabel(raw)
	return label === undefined ? undefined : TABLE.get(label)
}

/** Families whose messages are technical traffic, folded by default in the web app. */
export const TECHNICAL_FAMILIES: ReadonlySet<AcarsLabelFamily> = new Set([
	"link",
	"ground-station",
])

/** Display words for each family, as the `kind` field shows them. */
export const FAMILY_TEXT: Readonly<Record<AcarsLabelFamily, string>> = {
	link: "Link",
	"ground-station": "Ground station",
	"air-traffic": "Air traffic",
	airline: "Airline operations",
	onboard: "Onboard systems",
	weather: "Weather",
	maintenance: "Maintenance",
}

/** Display words for each basis, as the `basis` field shows them. */
export const BASIS_TEXT: Readonly<
	Record<AcarsLabelBasis | "decoded" | "unknown", string>
> = {
	decoded: "Standard, decoded",
	standard: "Standard format",
	listed: "Public label list",
	airline: "Airline's own format",
	unknown: "Unknown label",
}
