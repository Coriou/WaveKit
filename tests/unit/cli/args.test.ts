import { describe, expect, it } from "vitest"
import { HELP_TEXT, VIEW_ALIASES, parseArgs } from "../../../cli/source/args.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"

describe("parseArgs", () => {
	it("accepts new names and every old alias", () => {
		expect(parseArgs([])).toEqual({ kind: "run", view: "overview" })
		expect(parseArgs(["--view", "receiver"])).toEqual({
			kind: "run",
			view: "receiver",
		})
		const legacy: Record<string, string> = {
			dashboard: "overview",
			decoders: "decoders",
			output: "messages",
			backpressure: "decoders",
			sources: "receiver",
			tuner: "receiver",
			"live-audio": "system",
			resources: "system",
		}
		for (const [from, to] of Object.entries(legacy))
			expect(VIEW_ALIASES[from]).toBe(to)
		expect(parseArgs(["-v", "output"])).toEqual({
			kind: "run",
			view: "messages",
		})
		expect(parseArgs(["--view=tuner"])).toEqual({
			kind: "run",
			view: "receiver",
		})
		expect(parseArgs(["--api", "http://192.0.2.4:9000"])).toEqual({
			kind: "run",
			view: "overview",
			api: "http://192.0.2.4:9000",
		})
		expect(parseArgs(["--help"])).toEqual({ kind: "help" })
	})
	it("rejects invalid views with the valid names", () => {
		const r = parseArgs(["--view", "nope"])
		expect(r.kind).toBe("error")
		expect(r.kind === "error" && r.message).toContain(
			"overview, decoders, messages, receiver, system",
		)
		expect(parseArgs(["--bogus"]).kind).toBe("error")
		expect(parseArgs(["--api"]).kind).toBe("error")
	})
	it("handles flag edge cases", () => {
		expect(parseArgs(["--view"]).kind).toBe("error")
		expect(parseArgs(["--view="]).kind).toBe("error")
		expect(parseArgs(["--api="]).kind).toBe("error")
		expect(parseArgs(["-h"])).toEqual({ kind: "help" })
		expect(parseArgs(["--view", "nope", "--help"])).toEqual({ kind: "help" })
		expect(parseArgs(["--api=http://192.0.2.4:9000", "-v", "system"])).toEqual({
			kind: "run",
			view: "system",
			api: "http://192.0.2.4:9000",
		})
		// Object prototype keys are not views.
		expect(parseArgs(["--view", "constructor"]).kind).toBe("error")
		expect(parseArgs(["--view", "toString"]).kind).toBe("error")
	})
	it("documents views, aliases, --api and every env var without banned copy", () => {
		for (const s of [
			"overview",
			"dashboard",
			"--api",
			"WAVEKIT_API_URL",
			"WAVEKIT_WS_URL",
			"WAVEKIT_WS_URLS",
			"NO_COLOR",
			"WAVEKIT_ASCII",
		])
			expect(HELP_TEXT).toContain(s)
		for (const alias of Object.keys(VIEW_ALIASES))
			expect(HELP_TEXT).toContain(alias)
		expect(findBanned(HELP_TEXT)).toEqual([])
	})
	it("keeps error copy free of banned words", () => {
		for (const argv of [["--view", "nope"], ["--bogus"], ["--api"]]) {
			const r = parseArgs(argv)
			expect(r.kind === "error" && findBanned(r.message)).toEqual([])
		}
	})
})
