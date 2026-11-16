import { describe, expect, it, vi } from "vitest"
import type {
	RecordingInventoryItem,
	StorageArea,
	StorageAreaId,
	StorageReport,
} from "@wavekit/api-types"
import { listKeyAction } from "../../src/features/recordings/keys.ts"
import type { ListKeyContext } from "../../src/features/recordings/keys.ts"
import {
	countText,
	dayEntries,
	dayLabel,
	deleteBlocker,
	formatBytes,
	formatDuration,
	groupByDay,
	headerCount,
	recordingCutLabel,
	recordingMeta,
	recordingTitle,
	recordingsQuery,
	serverText,
	storageLine,
	suggest,
	textToken,
	withToken,
} from "../../src/features/recordings/model.ts"
import { savedNames } from "../../src/features/naming.ts"
import { RecordingPlayer } from "../../src/features/recordings/player.ts"
import type { AudioLike } from "../../src/features/recordings/player.ts"
import { visibleRecordings } from "../../src/features/recordings/ui-store.ts"
import { parseWav, wavPeaks } from "../../src/features/recordings/wav.ts"
import { synthWav } from "../../mock/recordings.ts"

const call = (
	patch: Partial<RecordingInventoryItem> = {},
): RecordingInventoryItem => ({
	id: "dsd:0~20261017_100000_00001_DMR_SLOT1_GROUP_TGT_2081_SRC_2081012.wav",
	kind: "dsd-fme-call",
	decoderId: "dsd-fme",
	discoveryId: null,
	startedAtLocal: "2026-10-17T10:00:00",
	modifiedAt: "2026-10-17T08:00:30.000Z",
	bytes: 340_000,
	durationMs: 42_000,
	callType: "group",
	talkgroup: "2081",
	source: "2081012",
	frequencyHz: null,
	kept: false,
	...patch,
})

const scan = (
	patch: Partial<RecordingInventoryItem> = {},
): RecordingInventoryItem =>
	call({
		id: "scan:d_01ABC~analog-1.wav",
		kind: "scanner-analog",
		decoderId: null,
		discoveryId: "d_01ABC",
		startedAtLocal: null,
		callType: null,
		talkgroup: null,
		source: null,
		frequencyHz: 156_800_000,
		...patch,
	})

describe("recording text", () => {
	it("names calls by talkgroup and scanner recordings by frequency, guessing nothing", () => {
		expect(recordingTitle(call())).toBe("TG 2081")
		expect(
			recordingTitle(call({ callType: "private", talkgroup: "2081045" })),
		).toBe("Private call to 2081045")
		expect(recordingTitle(call({ callType: "unit", source: "2081099" }))).toBe(
			"Unit 2081099",
		)
		expect(recordingTitle(call({ talkgroup: null, callType: null }))).toBe(
			"Voice call",
		)
		// a scanner recording is a transmission, never "Recording <Hz>"; the frequency moves to the meta line
		expect(recordingTitle(scan())).toBe("FM voice")
		expect(
			recordingTitle(scan({ kind: "scanner-dv", frequencyHz: 161_150_000 })),
		).toBe("Digital voice")
		expect(recordingTitle(scan({ frequencyHz: null }))).toBe("FM voice")
	})

	it("names a scanner recording by its channel's saved name, matched by raster frequency", () => {
		savedNames.set([{ frequencyHz: 156_800_000, name: "Harbour ops" }])
		try {
			// the measured carrier sits 0.4 kHz off the saved channel
			const r = scan({ frequencyHz: 156_800_400, bytes: 2_900_000 })
			expect(recordingTitle(r)).toBe("Harbour ops")
			expect(recordingMeta(r)).toBe("FM voice · 156.8000 · 2.9 MB")
			// a neighbouring channel 12.5 kHz away keeps its own name
			expect(recordingTitle(scan({ frequencyHz: 156_812_500 }))).toBe(
				"FM voice",
			)
		} finally {
			savedNames.set([])
		}
	})

	it("builds the meta line from the derived fields", () => {
		expect(recordingMeta(call())).toBe(
			"Call · radio 2081012 · dsd-fme · 340 kB",
		)
		expect(recordingMeta(scan({ bytes: 2_900_000 }))).toBe("156.8000 · 2.9 MB")
	})

	it.each([
		// [case, patch, label]
		["no cut reported", {}, null],
		["nothing at all", { cut: null, part: null, parts: null }, null],
		[
			"a part before the last never says Cut",
			{ cut: "duration-rollover", part: 1, parts: 3 },
			"Part 1 of 3 · continues",
		],
		[
			"a middle part",
			{ cut: "duration-rollover", part: 2, parts: 5 },
			"Part 2 of 5 · continues",
		],
		[
			"the last listed part that rolled over continues",
			{ cut: "duration-rollover", part: 5, parts: 5 },
			"Part 5 of 5 · continues",
		],
		[
			"an unresolved chain continues",
			{ cut: "duration-rollover", part: null, parts: null },
			"Continues…",
		],
		[
			"an unresolved chain, fields absent",
			{ cut: "duration-rollover" },
			"Continues…",
		],
		[
			"the end of the transmission explains itself",
			{ cut: "scanner-moved", part: 3, parts: 3 },
			// the file's length is not the offset in the whole transmission: no time
			"Part 3 of 3 · Scanner moved on, may be incomplete",
		],
		[
			"a lone file the scanner left",
			{ cut: "scanner-moved" },
			"Scanner moved on at 0:42, may be incomplete",
		],
		[
			"no length, no time",
			{ cut: "scanner-moved", durationMs: null },
			"Scanner moved on, may be incomplete",
		],
		["receiver lost", { cut: "source-lost" }, "Receiver lost"],
		["shutdown", { cut: "shutdown" }, "WaveKit stopped"],
	] as const)("cut label: %s", (_case, patch, label) => {
		const got = recordingCutLabel(
			scan(patch as Partial<RecordingInventoryItem>),
		)
		expect(got).toBe(label)
		expect(got ?? "").not.toMatch(/\bCut\b/)
	})

	it("puts the cut label at the end of the meta line", () => {
		expect(
			recordingMeta(scan({ bytes: 2_900_000, cut: "scanner-moved" })),
		).toBe("156.8000 · 2.9 MB · Scanner moved on at 0:42, may be incomplete")
	})

	it("formats durations and sizes like the board", () => {
		expect(formatDuration(42)).toBe("0:42")
		expect(formatDuration(365)).toBe("6:05")
		expect(formatDuration(3730)).toBe("1:02:10")
		expect(formatBytes(340_000)).toBe("340 kB")
		expect(formatBytes(922e6)).toBe("922 MB")
		expect(formatBytes(1.2e9)).toBe("1.2 GB")
	})

	it("labels days relative to today", () => {
		const now = new Date(2026, 9, 17, 15, 0)
		expect(dayLabel(new Date(2026, 9, 17, 1, 0), now)).toBe("Today")
		expect(dayLabel(new Date(2026, 9, 16, 23, 0), now)).toBe("Yesterday")
		expect(dayLabel(new Date(2026, 9, 8, 12, 0), now)).toBe(
			"Thursday 8 October",
		)
		expect(dayLabel(new Date(2025, 9, 8, 12, 0), now)).toBe(
			"Wednesday 8 October 2025",
		)
	})

	it("groups consecutive recordings by their start day", () => {
		const now = new Date(2026, 9, 17, 15, 0)
		const groups = groupByDay(
			[
				call({ startedAtLocal: "2026-10-17T14:00:00" }),
				call({ startedAtLocal: "2026-10-17T09:00:00" }),
				call({ startedAtLocal: "2026-10-16T20:00:00" }),
			],
			now,
		)
		expect(groups.map(g => [g.label, g.items.length])).toEqual([
			["Today", 2],
			["Yesterday", 1],
		])
	})

	it("only deletes unkept calls", () => {
		expect(deleteBlocker(call())).toBeNull()
		expect(deleteBlocker(call({ kept: true }))).toMatch(/Unkeep it first/)
		expect(deleteBlocker(scan())).toMatch(/Scanner/)
	})
})

describe("recording search", () => {
	it("offers typed chips; the core counts once one is chosen", () => {
		expect(suggest("2081", []).map(x => x.token.kind)).toEqual([
			"talkgroup",
			"radio",
			"text",
		])
		expect(suggest("156.8", []).map(x => x.token.label)).toContain(
			"156.800 MHz",
		)
		expect(suggest("call", []).map(x => x.token.label)).toContain("Calls")
		expect(suggest("  ", [])).toEqual([])
		// a chip already there is not offered again
		const tg = suggest("9", [])[0]?.token
		expect(tg?.kind).toBe("talkgroup")
		if (!tg) return
		expect(suggest("9", [tg]).map(x => x.token.kind)).toEqual(["radio", "text"])
	})

	it("turns the chips, the typed text and Kept into one core query", () => {
		const [tg, radio] = suggest("2081", []).map(x => x.token)
		const freq = suggest("156.8", []).find(x => x.token.kind === "frequency")
		const kind = suggest("call", []).find(x => x.token.kind === "kind")
		if (!tg || !radio || !freq || !kind) throw new Error("no chips")
		expect(
			recordingsQuery({
				tokens: [tg, radio, freq.token, kind.token],
				text: "",
				filter: "kept",
			}),
		).toEqual({
			kept: true,
			talkgroup: "2081",
			source: "2081",
			kind: "dsd-fme-call",
			minHz: 156_793_750,
			maxHz: 156_806_250,
		})
		expect(recordingsQuery({ tokens: [], text: "", filter: "all" })).toEqual({})
	})

	it("sends typed text as the core reads it, the typed text winning over a text chip", () => {
		expect(serverText(" TG 2081 ")).toBe("2081")
		expect(serverText("radio: 2081012")).toBe("2081012")
		expect(serverText("446,006 MHz")).toBe("446.006")
		expect(serverText("   ")).toBeNull()
		const chip = textToken("dmr")
		expect(recordingsQuery({ tokens: [chip], text: "", filter: "all" }).q).toBe(
			"dmr",
		)
		expect(
			recordingsQuery({ tokens: [chip], text: "161.15", filter: "all" }).q,
		).toBe("161.15")
	})

	it("keeps one chip per kind: a later one replaces it", () => {
		const a = suggest("9", [])[0]?.token
		const b = suggest("2081", [])[0]?.token
		if (!a || !b) throw new Error("no chips")
		const tokens = withToken(withToken([], a), b)
		expect(tokens.map(t => t.value)).toEqual(["2081"])
		expect(withToken(tokens, textToken("x")).map(t => t.kind)).toEqual([
			"talkgroup",
			"text",
		])
	})

	it("hides only the rows being deleted (the core filtered the rest)", () => {
		const list = [call({ id: "a" }), call({ id: "b" }), call({ id: "c" })]
		expect(visibleRecordings(list, new Set(["c"])).map(r => r.id)).toEqual([
			"a",
			"b",
		])
		expect(visibleRecordings(list, new Set())).toBe(list)
	})
})

describe("recordings list entries and counts", () => {
	it("puts a day label before each day's rows and numbers the rows", () => {
		const now = new Date("2026-10-17T12:00:00")
		const e = dayEntries(
			[
				call({ id: "a", startedAtLocal: "2026-10-17T10:00:00" }),
				call({ id: "b", startedAtLocal: "2026-10-17T09:00:00" }),
				call({ id: "c", startedAtLocal: "2026-10-16T22:00:00" }),
			],
			now,
		)
		expect(
			e.map(x => (x.type === "day" ? x.label : `${x.item.id}#${x.position}`)),
		).toEqual(["Today", "a#1", "b#2", "Yesterday", "c#3"])
	})

	it("counts from the core, never the loaded rows", () => {
		const meta = {
			counts: { total: 2350, kept: 12 },
			matched: 40,
			truncated: false,
		}
		expect(headerCount(meta, "all", false)).toBe("2,350")
		expect(headerCount(meta, "kept", false)).toBe("12")
		expect(headerCount(meta, "all", true)).toBe("40")
		expect(headerCount({ ...meta, truncated: true }, "all", false)).toBe(
			"2,350+",
		)
		expect(headerCount(null, "all", false)).toBeNull()
		expect(
			headerCount(
				{ counts: null, matched: null, truncated: false },
				"all",
				false,
			),
		).toBeNull()
		expect(countText(10000)).toBe("10,000")
	})
})

describe("recordings keyboard map", () => {
	const ctx = (patch: Partial<ListKeyContext> = {}): ListKeyContext => ({
		cursor: true,
		open: false,
		loaded: false,
		readOnly: false,
		deletable: true,
		...patch,
	})
	it("keeps every key of the list as it was", () => {
		const k = (key: string, patch: Partial<ListKeyContext> = {}) =>
			listKeyAction({ key }, ctx(patch))
		expect(k("ArrowDown")).toEqual({ type: "move", by: 1 })
		expect(k("ArrowUp")).toEqual({ type: "move", by: -1 })
		expect(k(" ")).toEqual({ type: "play" })
		expect(k(" ", { cursor: false })).toBeNull()
		expect(k("Enter")).toEqual({ type: "toggle-open" })
		expect(k("Escape")).toBeNull()
		expect(k("Escape", { open: true })).toEqual({ type: "close" })
		expect(k("k")).toBeNull()
		expect(k("k", { loaded: true })).toEqual({ type: "player-toggle" })
		expect(k("J", { loaded: true })).toEqual({ type: "seek", by: -1 })
		expect(k("l", { loaded: true })).toEqual({ type: "seek", by: 1 })
		expect(k("s")).toEqual({ type: "keep" })
		expect(k("s", { readOnly: true })).toBeNull()
		expect(k("Delete")).toEqual({ type: "delete" })
		expect(k("Backspace")).toEqual({ type: "delete" })
		expect(k("Delete", { deletable: false })).toBeNull()
		expect(k("Delete", { readOnly: true })).toBeNull()
		expect(k("x")).toBeNull()
	})
	it("leaves modified keys and keys typed in a field to their owner", () => {
		expect(listKeyAction({ key: "s", metaKey: true }, ctx())).toBeNull()
		expect(listKeyAction({ key: "ArrowDown", ctrlKey: true }, ctx())).toBeNull()
		expect(
			listKeyAction({ key: "j", altKey: true }, ctx({ loaded: true })),
		).toBeNull()
		expect(listKeyAction({ key: " ", inField: true }, ctx())).toBeNull()
	})
})

describe("storage line", () => {
	const area = (
		id: StorageAreaId,
		bytes: number,
		cap: number | null,
		exists = true,
	): StorageArea => ({
		id,
		class: "automatic",
		bytes,
		files: 1,
		exists,
		partial: false,
		partialReason: null,
		cap: cap === null ? null : { bytes: cap },
		retention: null,
	})
	const report = (areas: StorageArea[]): StorageReport =>
		({
			areas,
			filesystem: { totalBytes: 9e9, freeBytes: 5e9, availableBytes: 4e9 },
			lowSpace: { state: "ok" },
		}) as unknown as StorageReport

	it("says in words what auto-clean keeps, what kept means, and the free space", () => {
		expect(
			storageLine(
				report([
					area("scanner-evidence", 412e6, 2e9),
					area("iq-captures", 96e6, 640e6),
					area("digital-voice-wav", 1.6e9, null),
				]),
				3,
			),
		).toBe(
			"Call recordings: 1.6 GB. Scanner folder: 412 MB. Auto-clean keeps scanner recordings under 2.0 GB. IQ captures: 96.0 MB of 640 MB (new captures are refused at the limit). Kept items are never removed (3). 4.0 GB free on disk.",
		)
	})

	it("leaves out an area that does not exist and a missing report", () => {
		expect(storageLine(report([area("iq-captures", 0, 640e6, false)]), 0)).toBe(
			"Kept items are never removed (0). 4.0 GB free on disk.",
		)
		expect(storageLine(null, 1200)).toBe(
			"Kept items are never removed (1,200).",
		)
		// a core without counts: nothing about kept
		expect(storageLine(null, null)).toBe("")
	})
})

describe("WAV peaks", () => {
	it("reads the mock's 16-bit WAV and finds speech and silence", () => {
		const buf = synthWav(4, 3)
		const ab = new Uint8Array(buf).buffer
		const info = parseWav(ab)
		expect(info).toMatchObject({
			sampleRate: 8000,
			channels: 1,
			bitsPerSample: 16,
			float: false,
		})
		expect(info?.durationS).toBeCloseTo(4, 3)
		const out = wavPeaks(ab, 40)
		expect(out?.peaks).toHaveLength(40)
		const peaks = out?.peaks ?? []
		expect(Math.max(...peaks)).toBeGreaterThan(0.5)
		expect(Math.min(...peaks)).toBeLessThan(0.2)
	})

	it("reads 8-bit and float data and refuses what is not a WAV", () => {
		const wav = (format: number, bits: number, samples: number[]) => {
			const bytes = bits / 8
			const b = new ArrayBuffer(44 + samples.length * bytes)
			const v = new DataView(b)
			const w = (at: number, s: string) =>
				[...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
			w(0, "RIFF")
			v.setUint32(4, 36 + samples.length * bytes, true)
			w(8, "WAVE")
			w(12, "fmt ")
			v.setUint32(16, 16, true)
			v.setUint16(20, format, true)
			v.setUint16(22, 1, true)
			v.setUint32(24, 1000, true)
			v.setUint16(34, bits, true)
			w(36, "data")
			v.setUint32(40, samples.length * bytes, true)
			samples.forEach((s, i) => {
				if (bits === 8) v.setUint8(44 + i, Math.round(s * 127 + 128))
				else v.setFloat32(44 + i * 4, s, true)
			})
			return b
		}
		expect(wavPeaks(wav(1, 8, [0, 0, 1, 1]), 2)?.peaks[1]).toBeCloseTo(1, 1)
		expect(wavPeaks(wav(3, 32, [0.25, 0, 0, 0]), 2)?.peaks).toEqual([
			0.25 ** 0.75,
			0,
		])
		expect(parseWav(new ArrayBuffer(8))).toBeNull()
		expect(parseWav(wav(2, 8, [0]))).toBeNull()
	})
})

class FakeAudio implements AudioLike {
	src = ""
	currentTime = 0
	duration = Number.NaN
	playbackRate = 1
	preservesPitch = false
	playing = false
	private readonly handlers = new Map<string, (() => void)[]>()
	play() {
		this.playing = true
		return Promise.resolve()
	}
	pause() {
		this.playing = false
	}
	removeAttribute(name: string) {
		if (name === "src") this.src = ""
	}
	load() {}
	addEventListener(type: string, fn: () => void) {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn])
	}
	emit(type: string) {
		for (const fn of this.handlers.get(type) ?? []) fn()
	}
}

describe("RecordingPlayer", () => {
	const setup = (next: Record<string, string | null> = {}) => {
		const audio = new FakeAudio()
		const held: boolean[] = []
		const fetchFile = vi.fn((id: string) => {
			const buf = synthWav(2, id.length)
			return Promise.resolve(new Blob([new Uint8Array(buf)]))
		})
		const player = new RecordingPlayer({
			fetchFile,
			holdLive: h => held.push(h),
			nextOf: id => next[id] ?? null,
			createAudio: () => audio,
			createUrl: () => "blob:x",
			revokeUrl: () => {},
		})
		return { audio, held, fetchFile, player }
	}

	it("mutes live audio, plays the blob and unmutes on close", async () => {
		const { audio, held, player } = setup()
		await player.play("a", 1.5)
		expect(audio.src).toBe("blob:x")
		expect(audio.currentTime).toBe(1.5)
		expect(audio.playing).toBe(true)
		expect(player.get()).toMatchObject({ id: "a", phase: "playing" })
		player.toggle()
		expect(player.get().phase).toBe("paused")
		player.stop()
		expect(held).toEqual([true, false])
		expect(player.get().id).toBeNull()
	})

	it("advances to the next recording and stops at the end of the list", async () => {
		const { audio, player } = setup({ a: "bb" })
		await player.play("a")
		audio.duration = 2
		audio.emit("loadedmetadata")
		audio.emit("ended")
		await vi.waitFor(() =>
			expect(player.get()).toMatchObject({ id: "bb", phase: "playing" }),
		)
		audio.emit("ended")
		expect(player.get().phase).toBe("ended")
	})

	it("fetches each file once and computes its peaks", async () => {
		const { fetchFile, player } = setup()
		await player.loadPeaks("a")
		await player.play("a")
		expect(fetchFile).toHaveBeenCalledTimes(1)
		const peaks = player.peaks.get().get("a")
		expect(Array.isArray(peaks) && peaks.length).toBe(96)
	})

	it("cycles the speed and reports a failed fetch", async () => {
		const { audio, player } = setup()
		player.cycleSpeed()
		expect(player.get().speed).toBe(1.5)
		await player.play("a")
		expect(audio.playbackRate).toBe(1.5)
		const failing = new RecordingPlayer({
			fetchFile: () => Promise.reject(new Error("Recording not found")),
			holdLive: () => {},
			nextOf: () => null,
			createAudio: () => new FakeAudio(),
		})
		await failing.play("gone")
		expect(failing.get()).toMatchObject({
			phase: "error",
			error: "Recording not found",
		})
	})
})
