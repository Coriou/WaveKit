import { describe, expect, it, vi } from "vitest"
import type { RecordingInventoryItem } from "@wavekit/api-types"
import {
	dayLabel,
	deleteBlocker,
	formatBytes,
	formatDuration,
	groupByDay,
	matchesAll,
	recordingMeta,
	recordingTitle,
	suggest,
} from "../../src/features/recordings/model.ts"
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
		expect(recordingTitle(scan())).toBe("156.800 MHz")
		expect(
			recordingTitle(scan({ kind: "scanner-dv", frequencyHz: 161_150_000 })),
		).toBe("Digital voice 161.150")
		expect(recordingTitle(scan({ frequencyHz: null }))).toBe(
			"Scanner recording",
		)
	})

	it("builds the meta line from the derived fields", () => {
		expect(recordingMeta(call())).toBe(
			"Call · radio 2081012 · dsd-fme · 340 kB",
		)
		expect(recordingMeta(scan({ bytes: 2_900_000 }))).toBe(
			"Scanner · analog · 2.9 MB",
		)
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
	const items = [
		call(),
		call({ id: "x2", talkgroup: "9", source: "2081045" }),
		scan(),
	]

	it("offers typed chips with how many recordings each leaves", () => {
		const s = suggest("2081", items, [])
		expect(s.map(x => [x.token.kind, x.count])).toEqual([
			["talkgroup", 1],
			["text", 2],
		])
		expect(suggest("156.8", items, []).map(x => x.token.label)).toContain(
			"156.800 MHz",
		)
		expect(suggest("call", items, []).map(x => x.token.label)).toContain(
			"Calls",
		)
		expect(suggest("zzz", items, [])).toEqual([])
	})

	it("matches every chip and the typed text", () => {
		const tg = suggest("9", items, [])[0]?.token
		expect(tg?.kind).toBe("talkgroup")
		if (!tg) return
		expect(items.filter(r => matchesAll(r, [tg]))).toHaveLength(1)
		expect(items.filter(r => matchesAll(r, [], "radio 2081045"))).toHaveLength(
			1,
		)
	})

	it("hides deleting rows and shows only kept ones under Kept", () => {
		const list = [
			call({ id: "a", kept: true }),
			call({ id: "b" }),
			call({ id: "c", kept: true }),
		]
		const v = visibleRecordings(list, new Set(["c"]), {
			tokens: [],
			text: "",
			filter: "kept",
		})
		expect(v.map(r => r.id)).toEqual(["a"])
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
