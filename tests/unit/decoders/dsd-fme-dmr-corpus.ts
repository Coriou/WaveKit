/**
 * The in-repo DMR line corpus of the dsd-fme adapter: every recorded excerpt
 * (tests/mocks/fixtures/recorded/dsd-fme-dmr), the two dsd-fme fixtures, the synthetic
 * latency captures and the modelled scripts (shapes from private captures; ids, times and
 * colour codes synthetic). No private capture is read.
 */
import { readdirSync, readFileSync } from "node:fs"
import type { Line } from "./dsd-fme-call-first-helpers.js"

export const BS = (slot: 1 | 2, burst: string, cc = "01") =>
	slot === 1
		? `03:04:05 Sync: +DMR  [slot1]  slot2  | Color Code=${cc} | ${burst} `
		: `03:04:05 Sync: +DMR   slot1  [slot2] | Color Code=${cc} | ${burst} `
export const MS = (burst: string, cc = "11") =>
	`03:04:05 Sync: +DMR MS/DM MODE/MONO | Color Code=${cc} | ${burst} `
export const LC = (tg: number, src: number, kind = "Group Call") =>
	` SLOT 1 TGT=${tg} SRC=${src} ${kind} `
export const FLCO_FEC = " SLOT 1 FLCO FEC ERR  (FEC ERR)"
export const SLCO_CRC = " SLCO CRC ERR"
export const CSBK = " Channel Timing CSBK (CT_CSBK) "
export const NO_SYNC = "Sync: no sync"

/**
 * Modelled on 100041 (private repeater capture): slot 1's terminator train
 * of one talker, slot 2 idle, one PI burst of slot 2 with a CRC error, no
 * voice burst decoded.
 */
export function repeaterTrain(from: number, tg = 9001, src = 91): Line[] {
	const lines: Line[] = [
		[from, BS(2, "PI  \x1b[31m (CRC ERR) \x1b[0m", "00")],
		[from + 1, BS(2, "IDLE")],
	]
	for (let i = 0; i < 6; i++) {
		const t = from + 300 + i * 120
		lines.push([t, BS(1, "TLC")], [t + 1, LC(tg, src)], [t + 2, SLCO_CRC])
		lines.push([t + 60, BS(2, "IDLE")])
	}
	lines.push([from + 1100, NO_SYNC])
	return lines
}

/**
 * Modelled on 090127 (private direct capture): the capture opens on the end
 * of one transmission (two voice bursts whose link control failed, its
 * terminator and link control), then another talker's whole over.
 */
export function directCutStart(): Line[] {
	return [
		[0, MS("VC*", "15")],
		[1, FLCO_FEC],
		[60, MS("VC*", "10")],
		[61, FLCO_FEC],
		[120, MS("TLC")],
		[121, LC(9001, 91)],
		[180, MS("CSBK")],
		[181, CSBK],
		[200, NO_SYNC],
		[1000, MS("CACH/Burst FEC ERR", "15")],
		[1060, MS("VLC", "15")],
		[1061, LC(9002, 92)],
		[1120, MS("VC*")],
		[1121, LC(9002, 92)],
		[1480, MS("VC*")],
		[1481, LC(9002, 92)],
		[1840, MS("TLC")],
		[1841, LC(9002, 92)],
		[1900, MS("CSBK")],
		[1901, CSBK],
		[1920, NO_SYNC],
	]
}

/**
 * Modelled on 091133 (private direct capture): one talker's over (header,
 * voice, a failed link control), then a voice burst and the terminator both
 * naming another talker (two agreeing copies) with no gap between them.
 */
export function directNextTalker(): Line[] {
	const lines: Line[] = [
		[0, MS("CACH/Burst FEC ERR")],
		[60, MS("VLC")],
		[61, LC(9001, 91)],
	]
	for (let i = 0; i < 4; i++) {
		const t = 120 + i * 360
		lines.push([t, MS("VC*")], [t + 1, i === 3 ? FLCO_FEC : LC(9001, 91)])
	}
	lines.push(
		[1560, MS("VC*")],
		[1561, LC(9002, 92)],
		[1620, MS("TLC")],
		[1621, LC(9002, 92)],
		[1680, MS("CSBK")],
		[1681, CSBK],
		[1700, NO_SYNC],
	)
	return lines
}

/**
 * A direct transmission's end: voice bursts, a terminator whose link
 * control failed its CRC, then the same terminator repeated clean (TLC + LC
 * copies 60 ms apart). Modelled (ids and times synthetic).
 */
export function directErroredTrailer(voice: number, step = 360): Line[] {
	const lines: Line[] = []
	for (let i = 0; i < voice; i++)
		lines.push([i * step, MS("VC*")], [i * step + 1, FLCO_FEC])
	const tlc = voice * step
	lines.push(
		[tlc, MS("TLC")],
		[tlc + 1, `${LC(9001, 91)}\x1b[31m (CRC ERR)\x1b[0m`],
	)
	for (let i = 1; i <= 5; i++)
		lines.push([tlc + i * 60, MS("TLC")], [tlc + i * 60 + 1, LC(9001, 91)])
	lines.push([tlc + 400, NO_SYNC])
	return lines
}

/** Every DMR line script of the repository: recorded excerpts and synthetic captures. */
export function corpus(): { name: string; mode: string; lines: Line[] }[] {
	const out: { name: string; mode: string; lines: Line[] }[] = []
	const tabbed = (path: string): Line[] =>
		readFileSync(path, "utf8")
			.split("\n")
			.filter(line => line !== "" && !line.startsWith("#"))
			.map((line): Line => {
				const tab = line.indexOf("\t")
				return [Number(line.slice(0, tab)), line.slice(tab + 1)]
			})
	const recorded = "tests/mocks/fixtures/recorded/dsd-fme-dmr"
	for (const file of readdirSync(recorded).filter(f => f.endsWith(".txt")))
		out.push({
			name: file,
			mode: "auto",
			lines: tabbed(`${recorded}/${file}`),
		})
	for (const file of ["dmr-ms-two-ptt.txt", "dmr-bs-checked-csbk.txt"])
		out.push({
			name: file,
			mode: "auto",
			lines: tabbed(`tests/mocks/fixtures/dsd-fme/${file}`),
		})
	const synthetic = "tests/mocks/fixtures/synthetic"
	for (const file of readdirSync(synthetic).filter(f =>
		/^dv-latency-dmr-.*\.json$/.test(f),
	)) {
		const json = JSON.parse(readFileSync(`${synthetic}/${file}`, "utf8")) as {
			lines: { atMs: number; text: string }[]
		}
		out.push({
			name: file,
			mode: "auto",
			lines: json.lines.map((l): Line => [Math.round(l.atMs), l.text]),
		})
	}
	out.push(
		{
			name: "modelled repeater train",
			mode: "auto",
			lines: repeaterTrain(1000),
		},
		{
			name: "modelled direct cut start",
			mode: "auto",
			lines: directCutStart(),
		},
		{
			name: "modelled direct next talker",
			mode: "auto",
			lines: directNextTalker(),
		},
		{
			name: "modelled direct errored trailer",
			mode: "auto",
			lines: directErroredTrailer(2, 60),
		},
	)
	return out
}
