/**
 * Manifest v2 fixture entries for captures, validated with the fixture manifest's own
 * FixtureSchema (src/core/fixtures/manifest-schema.ts), so a sidecar is exactly a manifest entry.
 */
import { FixtureSchema, type Fixture } from "../../fixtures/manifest-schema.js"
import type { Identity, ScannerProtocol } from "../types.js"

export interface CaptureFacts {
	id: string
	mode: "wideband" | "channel"
	sampleRateHz: number
	sourceCentreHz: number
	targetHz: number
	durationS: number
	sha256: string
	bytes: number
	decoderType: string | null
	decoderOptions: Record<string, unknown>
	protocol: ScannerProtocol
	decoded: boolean
	metadata: {
		talkgroups: string[]
		sources: string[]
		capcodes: string[]
		callsigns: string[]
		ismModels: string[]
	}
	identity?: Identity
	jobId: string
	sourceId: string
	createdAt: string
}

const LARGE_BYTES = 64 * 1024 * 1024

/** Expected payload fields in the decoder's own output vocabulary. */
function payloadOf(f: CaptureFacts): Record<string, string | number> {
	const p: Record<string, string | number> = {}
	const m = f.metadata
	const id = f.identity
	switch (f.decoderType) {
		case "dsd-fme": {
			const tg = Number(m.talkgroups[0])
			const src = Number(m.sources[0])
			if (Number.isInteger(tg)) p["talkgroup"] = tg
			if (Number.isInteger(src)) p["source"] = src
			break
		}
		case "multimon-ng": {
			const capcode =
				m.capcodes[0] ?? (id?.kind === "pocsag-capcode" ? id.value : undefined)
			if (capcode) p["capcode"] = capcode
			break
		}
		case "direwolf": {
			const call =
				m.callsigns[0] ?? (id?.kind === "aprs-call" ? id.value : undefined)
			if (call) p["source"] = call
			break
		}
		case "rtl433": {
			const model =
				m.ismModels[0] ?? (id?.kind === "ism-model" ? id.value : undefined)
			if (model) p["model"] = model
			break
		}
	}
	return p
}

export function buildFixtureEntry(f: CaptureFacts): Fixture {
	const payload = f.decoded ? payloadOf(f) : {}
	const keys = Object.keys(payload)
	const expected = f.decoded
		? {
				min_count: 1,
				payloads: keys.length > 0 ? [payload] : [],
				...(keys.length > 0 ? { key_fields: keys } : {}),
			}
		: { min_count: 0, payloads: [] }
	const golden =
		f.mode === "wideband" &&
		f.decoded &&
		keys.length > 0 &&
		f.sampleRateHz >= 2_048_000
	const entry = {
		id: f.id,
		role: golden ? ("channelizer-golden" as const) : ("tail-golden" as const),
		decoder: f.decoderType ?? "unknown",
		decoder_options: f.decoderOptions,
		license: "private",
		provenance: {
			notes: `scanner capture ${f.id}: job ${f.jobId}, source ${f.sourceId}, ${f.protocol} at ${f.targetHz} Hz, ${f.mode}, ${f.createdAt}`,
		},
		fetch: { kind: "private" as const },
		file: `raw/${f.id}.cu8`,
		sha256: f.sha256,
		format: "cu8" as const,
		sample_rate: f.sampleRateHz,
		center_hz: f.mode === "wideband" ? f.sourceCentreHz : f.targetHz,
		duration_s: f.durationS,
		playback_speed: 1,
		large: f.bytes > LARGE_BYTES,
		expected,
		...(f.mode === "wideband" ? { channel: { center_hz: f.targetHz } } : {}),
	}
	return FixtureSchema.parse(entry)
}
