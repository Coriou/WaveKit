/**
 * Decode-margin harness for dsd-fme's 4FSK protocols (dsd-fme-margin.test.ts).
 *
 * One measurement point: a synthetic transmission with its air interface's
 * own transmit filter (fsk-iq.mjs AIR_SHAPES), FM-modulated as cu8 IQ at a
 * channel offset plus a carrier frequency error, with white noise at a given
 * CNR (in 12.5 kHz). Then the production channel path: wavekit-chan with the
 * adapter's own channel request, and the adapter's own command line for
 * channel IQ (synthetic-chain.ts runs it, in the core image with
 * WAVEKIT_SYNTH_IMAGE). dsd-fme also writes its symbol decisions (-c).
 *
 * Two numbers per point:
 * - FER: the share of the frames with a CRC- or FEC-checked field that
 *   dsd-fme did not print as checked (frameCount below says which, per
 *   protocol);
 * - SER: dsd-fme's symbol decisions (the -c capture) against the sent
 *   symbols, counted only where the capture is aligned (symbolErrors).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import pino from "pino"
import { fmCu8 } from "../../scripts/fixtures/fsk-iq.mjs"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"
import { DsdFmeDecoder } from "../../src/decoders/builtin/dsd-fme.js"
import {
	HAS_CSDR,
	channelize,
	csdrFmHead,
	runShell,
	workDir,
} from "./synthetic-chain.js"

const silent = pino({ level: "silent" })

export class DsdMarginProbe extends DsdFmeDecoder {
	pipeline(): string {
		return this.buildPipelineCommand()
	}
}

export const MARGIN_CENTRE_HZ = 433_000_000
/** The captures the chain tests use (synthetic-frames.test.ts CAPTURES). */
export const MARGIN_CAPTURES = {
	"1024000": { rateHz: 1_024_000, offsetHz: 162_500 },
	"2400000": { rateHz: 2_400_000, offsetHz: -287_500 },
} as const
/** WAVEKIT_MARGIN_RATE picks one (default 1.024 Msps). */
export const MARGIN_CAPTURE =
	process.env["WAVEKIT_MARGIN_RATE"] === "2400000"
		? MARGIN_CAPTURES["2400000"]
		: MARGIN_CAPTURES["1024000"]

/** A transmission: what was sent, and how to count its checked frames. */
export interface MarginSignal {
	name: string
	/** Adapter mode that decodes it (the catalogue default where it can). */
	mode: string
	freq: Float64Array
	/** Sent symbols, dsd-fme's dibit codes (1 = +3, 0 = +1, 2 = -1, 3 = -3). */
	dibits: number[]
	/** Frames sent that carry the checked field `checked` counts. */
	frames: number
	/** Frames dsd-fme printed as checked, from its output lines. */
	checked: (lines: string[]) => number
}

/**
 * A chain configuration: adapter options for both paths. The other fields
 * try out a change before it is an adapter option: `request` overrides the
 * channel request, `pcm` rewrites the discriminator output (s16 at 48 kHz,
 * with the carrier frequency error the point applies), `soxEffects` go after
 * sox's output and `dsdArgs` after dsd-fme's.
 */
export interface MarginVariant {
	name: string
	options: Record<string, unknown>
	request?: Partial<DecoderChannelRequest>
	pcm?: (pcm: Buffer, point: { errorHz: number; gain: number }) => Buffer
	soxEffects?: string
	dsdArgs?: string[]
}

export interface MarginPoint {
	signal: string
	variant: string
	cnrDb: number
	errorHz: number
	frames: number
	checked: number
	symbols: number
	symbolErrors: number
}

/** ANSI colour codes off, as the adapter's parser strips them. */
export function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "")
}

/**
 * Symbol errors of dsd-fme's decisions `captured` (its -c capture: one byte
 * per symbol, the dibit code) against `sent`. dsd-fme slips and skips symbols
 * (sync search, timing), so each window of `window` captured symbols is
 * matched at the sent offset with the fewest mismatches, preferring the
 * previous window's offset +-`slip`. A window counts only when it matches
 * with at most `maxShare` mismatches: noise, carrier-off and frames dsd-fme
 * read while hunting for sync (two-level decisions, about half wrong) do not
 * match and are not counted; those losses show in the frame error rate.
 */
export function symbolErrors(
	captured: Uint8Array,
	sent: readonly number[],
	{ window = 48, slip = 4, maxShare = 0.25 } = {},
): { symbols: number; errors: number } {
	const limit = Math.floor(window * maxShare)
	const mismatches = (start: number, offset: number, cap: number) => {
		let m = 0
		for (let i = 0; i < window && m <= cap; i++)
			if (captured[start + i] !== sent[offset + i]) m++
		return m
	}
	let symbols = 0
	let errors = 0
	let previous = -1
	for (let start = 0; start + window <= captured.length; start += window) {
		let best = limit + 1
		let at = -1
		if (previous >= 0) {
			const expected = previous + window
			for (let d = -slip; d <= slip; d++) {
				const o = expected + d
				if (o < 0 || o + window > sent.length) continue
				const m = mismatches(start, o, best - 1)
				if (m < best) {
					best = m
					at = o
				}
			}
		}
		if (at < 0)
			for (let o = 0; o + window <= sent.length; o++) {
				const m = mismatches(start, o, best - 1)
				if (m < best) {
					best = m
					at = o
				}
			}
		if (at < 0 || best > limit) {
			previous = -1
			continue
		}
		previous = at
		symbols += window
		errors += best
	}
	return { symbols, errors }
}

function adapter(
	signal: MarginSignal,
	variant: MarginVariant,
	path: "channel" | "raw",
): DsdMarginProbe {
	return new DsdMarginProbe(
		{
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options:
				path === "channel"
					? {
							mode: signal.mode,
							...variant.options,
							inputSampleRate: 48_000,
							inputIqFormat: "cf32",
						}
					: {
							mode: signal.mode,
							...variant.options,
							inputSampleRate: MARGIN_CAPTURE.rateHz,
							offsetHz: MARGIN_CAPTURE.offsetHz,
						},
		},
		silent,
	)
}

/** The channel-path command, split at sox, with the csdr head's gain. */
export function channelCommand(probe: DsdMarginProbe): {
	head: string[]
	tail: string[]
	gain: number
} {
	const stages = probe.pipeline().split(" | ")
	const soxAt = stages.findIndex(s => s.startsWith("sox "))
	const head = stages.slice(0, soxAt)
	const gain = /^csdr gain (?<g>[0-9.]+)$/.exec(head[1] ?? "")?.groups?.["g"]
	if (
		soxAt < 0 ||
		head.length !== 4 ||
		head[0] !== "csdr fmdemod" ||
		gain === undefined ||
		head[2] !== "csdr limit" ||
		head[3] !== "csdr convert -i float -o s16"
	)
		throw new Error(
			`the in-process FM head does not match the channel command: ${head.join(" | ")}`,
		)
	return { head, tail: stages.slice(soxAt), gain: Number(gain) }
}

/** Runs one point through wavekit-chan and the adapter's channel command. */
export async function measurePoint(
	chanBinary: string,
	root: string,
	signal: MarginSignal,
	variant: MarginVariant,
	{ cnrDb, errorHz, seed }: { cnrDb: number; errorHz: number; seed: number },
): Promise<MarginPoint> {
	const iq = fmCu8(signal.freq, {
		sampleRateHz: MARGIN_CAPTURE.rateHz,
		offsetHz: MARGIN_CAPTURE.offsetHz + errorHz,
		cnrDb,
		seed,
	})
	const request = {
		...(adapter(signal, variant, "raw").getChannelRequest({
			sampleRateHz: MARGIN_CAPTURE.rateHz,
			centerHz: MARGIN_CENTRE_HZ,
		}) as DecoderChannelRequest),
		...variant.request,
	}
	const [cf32] = await channelize(
		chanBinary,
		iq,
		{ rateHz: MARGIN_CAPTURE.rateHz, centerHz: MARGIN_CENTRE_HZ },
		[request],
	)
	const probe = adapter(signal, variant, "channel")
	const { head, tail, gain } = channelCommand(probe)
	const dir = workDir(root, "margin")
	try {
		const input = join(dir, "in")
		const capture = join(dir, "symbols.bin")
		const inProcess = !HAS_CSDR || variant.pcm !== undefined
		const head16 = inProcess ? csdrFmHead(cf32!, gain) : cf32!
		writeFileSync(
			input,
			variant.pcm === undefined
				? head16
				: variant.pcm(head16, { errorHz, gain }),
		)
		const stages = inProcess ? [...tail] : [...head, ...tail]
		const sox = stages.findIndex(s => s.startsWith("sox "))
		if (variant.soxEffects !== undefined)
			stages[sox] += ` ${variant.soxEffects}`
		stages[stages.length - 1] +=
			` ${[...(variant.dsdArgs ?? []), "-c", capture].join(" ")}`
		const { lines } = runShell(stages.join(" | "), input, dir)
		let captured = new Uint8Array(0)
		try {
			captured = new Uint8Array(readFileSync(capture))
		} catch {
			// No symbol written: nothing aligned.
		}
		const ser = symbolErrors(captured, signal.dibits)
		const dump = process.env["WAVEKIT_MARGIN_LINES"]
		if (dump !== undefined && dump !== "")
			writeFileSync(
				join(
					dump,
					`${signal.name}-${variant.name}-${cnrDb}dB-${errorHz}Hz-${seed}.txt`.replace(
						/[^A-Za-z0-9.+-]/g,
						"_",
					),
				),
				lines.map(plain).join("\n"),
			)
		return {
			signal: signal.name,
			variant: variant.name,
			cnrDb,
			errorHz,
			frames: signal.frames,
			checked: Math.min(signal.frames, signal.checked(lines.map(plain))),
			symbols: ser.symbols,
			symbolErrors: ser.errors,
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/** Sums points that share signal, variant, CNR and frequency error. */
export function aggregate(points: MarginPoint[]): MarginPoint[] {
	const byKey = new Map<string, MarginPoint>()
	for (const p of points) {
		const key = `${p.signal}|${p.variant}|${p.cnrDb}|${p.errorHz}`
		const sum = byKey.get(key)
		if (sum === undefined) byKey.set(key, { ...p })
		else {
			sum.frames += p.frames
			sum.checked += p.checked
			sum.symbols += p.symbols
			sum.symbolErrors += p.symbolErrors
		}
	}
	return [...byKey.values()]
}

const percent = (n: number, d: number) =>
	d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)} %`

/** Markdown: one row per signal and variant, FER (SER) per CNR column. */
export function marginTable(points: MarginPoint[], errorHz: number): string {
	const rows = aggregate(points).filter(p => p.errorHz === errorHz)
	const cnrs = [...new Set(rows.map(p => p.cnrDb))].sort((a, b) => a - b)
	const keys = [...new Set(rows.map(p => `${p.signal}|${p.variant}`))]
	const out = [
		`| Signal | Chain | ${cnrs.map(c => `${c} dB`).join(" | ")} |`,
		`| --- | --- | ${cnrs.map(() => "---").join(" | ")} |`,
	]
	for (const key of keys) {
		const [signal, variant] = key.split("|") as [string, string]
		const cells = cnrs.map(c => {
			const p = rows.find(
				r => r.signal === signal && r.variant === variant && r.cnrDb === c,
			)
			return p === undefined
				? ""
				: `${percent(p.frames - p.checked, p.frames)} (${percent(p.symbolErrors, p.symbols)})`
		})
		out.push(`| ${signal} | ${variant} | ${cells.join(" | ")} |`)
	}
	return out.join("\n")
}
