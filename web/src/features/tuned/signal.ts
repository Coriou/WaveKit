// Small pure helpers of the tuned card.

/** The card's 5-bar signal glyph: lit bars for an SNR in dB (null: none lit). */
export function signalBars(snrDb: number | null): number {
	if (snrDb === null || !Number.isFinite(snrDb)) return 0
	const steps = [3, 8, 14, 20, 28]
	return steps.filter(s => snrDb >= s).length
}

const DECODER: Readonly<Record<string, string>> = {
	"dsd-fme": "Digital voice",
	"ais-catcher": "AIS",
	"multimon-ng": "Pager",
	direwolf: "APRS",
	rtl433: "ISM sensors",
	acarsdec: "ACARS",
	dumpvdl2: "VDL2",
	"lora-meshtastic": "Meshtastic",
	readsb: "ADS-B",
	dump1090: "ADS-B",
}

/** What a decoder type decodes, in words ("AIS" for ais-catcher); the type itself when unknown. */
export function decoderLabel(type: string): string {
	return DECODER[type] ?? type
}
