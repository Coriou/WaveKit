import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import {
	SourceFanoutRouter,
	defaultSourceIdFor,
} from "../../../src/core/source-fanout-router.js"
import type { SourceManager } from "../../../src/core/source-manager.js"

const logger = pino({ level: "silent" })

class Sources extends EventEmitter {
	constructor(
		readonly ids: string[],
		readonly connected = new Set<string>(),
	) {
		super()
	}
	getAllStatus() {
		return this.ids.map(id => ({ id, connected: this.connected.has(id) }))
	}
	getStatus(id: string) {
		return this.ids.includes(id)
			? { id, connected: this.connected.has(id) }
			: undefined
	}
	getStream() {
		return new PassThrough()
	}
	getCaps() {
		return undefined
	}
}

describe("dedicated scanner sources (spec § 10.7)", () => {
	it("defaultSourceIdFor picks the first shared source", () => {
		expect(
			defaultSourceIdFor([
				{ id: "scan", scanner: { role: "dedicated", passive: true } },
				{ id: "main" },
			]),
		).toBe("main")
		expect(defaultSourceIdFor([{ id: "a" }, { id: "b" }])).toBe("a")
		expect(
			defaultSourceIdFor([
				{ id: "scan", scanner: { role: "dedicated", passive: true } },
			]),
		).toBeUndefined()
	})

	it("never falls back to a dedicated source, whichever connects first", () => {
		const sources = new Sources(["scan", "main"])
		const primary = new FanoutManager(logger)
		const router = new SourceFanoutRouter(
			sources as unknown as SourceManager,
			primary,
			logger,
			undefined,
			{
				dedicated: new Set(["scan"]),
			},
		)
		sources.connected.add("scan")
		sources.emit("connected", "scan")
		expect(router.getDefaultSourceId()).toBe("main")
		expect(router.getFanout("scan")).not.toBe(primary)
		expect(router.getFanout(undefined)).toBe(primary)
		expect(router.getFanout("main")).toBe(primary)
		router.destroy()
	})

	it("has no default when every source is dedicated", () => {
		const sources = new Sources(["scan"])
		const primary = new FanoutManager(logger)
		const router = new SourceFanoutRouter(
			sources as unknown as SourceManager,
			primary,
			logger,
			undefined,
			{
				dedicated: new Set(["scan"]),
			},
		)
		expect(router.getDefaultSourceId()).toBeUndefined()
		expect(router.getFanout("scan")).not.toBe(primary)
		router.destroy()
	})
})
