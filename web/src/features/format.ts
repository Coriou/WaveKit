// Frequency and level text shared by the islands and the tuned card (the boards' kfmt / MHZ helpers).

/** "12.5 kHz", "500 Hz", "1.2 MHz": a width or a step. */
export function formatWidth(hz: number): string {
	const a = Math.abs(hz)
	if (a >= 1e6) return `${trim((hz / 1e6).toFixed(3))} MHz`
	if (a >= 1000) return `${trim((hz / 1000).toFixed(2))} kHz`
	return `${Math.round(hz)} Hz`
}

/** "161.150" for kHz-aligned frequencies, "446.00625" otherwise (no unit). */
export function formatMHz(hz: number): string {
	const r = Math.round(hz)
	if (r % 1000 === 0) return (r / 1e6).toFixed(3)
	return trimTo3((r / 1e6).toFixed(6))
}

/** Step label for a chip: "6.25k", "12.5k", "100k", "500". */
export function formatStep(hz: number): string {
	if (hz >= 1000) return `${trim((hz / 1000).toFixed(2))}k`
	return String(hz)
}

export function formatDb(db: number, digits = 1): string {
	const t = db.toFixed(digits)
	return t.replace("-", "−")
}

/** "2.4 MS/s". */
export function formatRate(sps: number): string {
	if (sps >= 1e6) return `${trim((sps / 1e6).toFixed(3))} MS/s`
	if (sps >= 1000) return `${trim((sps / 1000).toFixed(1))} kS/s`
	return `${sps} S/s`
}

function trim(text: string): string {
	return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text
}

/** Trims trailing zeros but keeps at least three decimals. */
function trimTo3(text: string): string {
	const [int, frac = ""] = text.split(".")
	const kept = frac.replace(/0+$/, "")
	return `${int}.${kept.padEnd(3, "0")}`
}
