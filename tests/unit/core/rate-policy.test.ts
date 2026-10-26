import { describe, it, expect } from "vitest"
import { createServer, createConnection } from "node:net"
import type { AddressInfo } from "node:net"
import { once } from "node:events"
import { createRatePolicy } from "../../../src/core/rate-policy.js"
import type { TunerWriteOptions } from "../../../src/core/tuner-controller.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type {
	TunerRatePolicyEventData,
	TunerState,
	DecoderMode,
	LinkAdvisory,
} from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"
import { WaveKitError } from "../../../src/utils/errors.js"

async function harness(enabled = true, dropRate = false) {
	const received: Buffer[] = []
	const server = createServer(socket => {
		let pending = Buffer.alloc(0)
		socket.on("data", data => {
			received.push(data)
			pending = Buffer.concat([pending, data])
			while (pending.length >= 5) {
				const command = pending.readUInt8(0)
				pending = pending.subarray(5)
				if (dropRate && command === 2) socket.resetAndDestroy()
			}
		})
		socket.on("error", () => {})
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const socket = createConnection({
		host: "127.0.0.1",
		port: (server.address() as AddressInfo).port,
	})
	let transportError: Error | undefined
	socket.on("error", err => {
		transportError = err
	})
	await once(socket, "connect")
	const disconnected = new Promise<void>(resolve =>
		socket.once("close", () => resolve()),
	)
	const commands: Array<[number, number]> = []
	let fail = false
	const source = {
		assertTunerCommandActive() {},
		writeToSource(_id: string, frame: Buffer) {
			if (fail && frame[0] === 2)
				throw new WaveKitError("rate failed", "TEST_RATE_FAILED")
			commands.push([frame.readUInt8(0), frame.readUInt32BE(1)])
			return socket.write(frame)
		},
		updateSourceCaps() {},
		isRtlTcpSource() {
			return true
		},
	}
	const log = createLogger({ level: "fatal" })
	const tuner = new TunerController(log, source as unknown as SourceManager)
	tuner.on("error", () => {})
	tuner.initializeSource("s", {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 162_000_000,
		format: "U8_IQ",
		exclusive: false,
	})
	let mode: DecoderMode = "auto"
	let ownDevice = false
	const origins: Array<string | undefined> = []
	tuner.on(
		"command-sent",
		(_id: string, _command: string, _value: number, origin?: string) => {
			origins.push(origin)
		},
	)
	const events: TunerRatePolicyEventData[] = []
	const link: LinkAdvisory = {
		level: "unproven",
		transport: "network",
		payloadBytesPerSecond: 4_800_000,
		sustainedBytesPerSecond: null,
		shortfallPercent: null,
		upstreamDropBytesPerSecond: null,
	}
	const reports: LinkAdvisory[] = []
	const policy = createRatePolicy({
		port: { readsbOn: () => ({ mode, ownDevice }) },
		tuner: {
			sampleRateOf: id => tuner.getState(id)?.sampleRate ?? null,
			controlModeOf: id => tuner.getState(id)?.controlMode ?? null,
			async setSampleRate(id, hz, opts) {
				await tuner.setSampleRate(id, hz, opts)
				if (dropRate) {
					await disconnected
					if (transportError) throw transportError
					throw new WaveKitError(
						"RTL-TCP peer disconnected",
						"SOURCE_CONNECTION_ERROR",
					)
				}
			},
		},
		link: { observe() {}, reset() {}, classify: () => link },
		linkInput: sourceId => ({
			sourceId,
			host: "localhost",
			sampleRateHz: 2_048_000,
		}),
		upstreamDropsOf: () => null,
		reportLink: (_id, value) => {
			reports.push(value)
		},
		setTimer: () => ({ cancel() {} }),
		emit: event => {
			events.push(event)
		},
		now: () => new Date(0),
		log,
		enabled,
	})
	tuner.setBeforeOperatorRetune((...args) =>
		policy.beforeOperatorRetune(...args),
	)
	tuner.setOnOperatorSampleRate(id => policy.onOperatorSampleRate(id))
	tuner.setOnRelayRetune((id, hz) => policy.onRelayRetune(id, hz))
	tuner.setRatePolicyRecordFor(id => policy.recordFor(id))
	return {
		tuner,
		policy,
		commands,
		received,
		events,
		reports,
		origins,
		link,
		setMode(value: DecoderMode) {
			mode = value
		},
		setOwn(value: boolean) {
			ownDevice = value
		},
		setFail() {
			fail = true
		},
		async close() {
			policy.dispose()
			if (!socket.destroyed) socket.end()
			await disconnected
			await new Promise<void>((resolve, reject) =>
				server.close(err => (err ? reject(err) : resolve())),
			)
			const wire = Buffer.concat(received)
			expect(wire.length).toBe(commands.length * 5)
			for (let i = 0; i < commands.length; i++)
				expect([wire.readUInt8(i * 5), wire.readUInt32BE(i * 5 + 1)]).toEqual(
					commands[i],
				)
		},
	}
}

describe("rate policy", () => {
	it("raises before frequency and restores before leaving reach", async () => {
		const h = await harness()
		try {
			await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			expect(h.commands).toEqual([
				[2, 2_400_000],
				[1, 1_090_000_000],
			])
			expect(h.tuner.getState("s")?.ratePolicy).toEqual({
				raisedFromHz: 2_048_000,
				since: new Date(0).toISOString(),
			})
			expect(h.events[0]?.link).toEqual(h.link)
			expect(h.reports).toEqual([h.link])
			expect(h.origins).toEqual(["decoder-rate", "rest"])
			await h.tuner.setFrequency("s", 162_000_000, { origin: "rest" })
			expect(h.commands.slice(2)).toEqual([
				[2, 2_048_000],
				[1, 162_000_000],
			])
			expect(h.tuner.getState("s")?.ratePolicy).toBeUndefined()
		} finally {
			await h.close()
		}
	})
	it.each([1_090_200_000, 1_090_200_001])("reach boundary %i", async hz => {
		const h = await harness()
		try {
			await h.tuner.setFrequency("s", hz, { origin: "rest" })
			expect(h.events.filter(e => e.action === "raised")).toHaveLength(
				hz === 1_090_200_000 ? 1 : 0,
			)
		} finally {
			await h.close()
		}
	})
	it("operator and accepted relay rates clear restore records", async () => {
		const h = await harness()
		try {
			await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			await h.tuner.setSampleRate("s", 2_000_000, { origin: "rest" })
			expect(h.policy.recordFor("s")).toBeUndefined()
			await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			h.tuner.applyExternalCommand("s", 2, 2_048_000)
			expect(h.policy.recordFor("s")).toBeUndefined()
			h.tuner.setControlMode("s", "internal")
			await h.tuner.setFrequency("s", 162_000_000, { origin: "rest" })
			expect(h.events.filter(e => e.action === "restored")).toHaveLength(0)
		} finally {
			await h.close()
		}
	})
	it("relay advice is edge triggered and rearmed by exit, reset and internal control", async () => {
		const h = await harness()
		try {
			for (const hz of [
				1_090_000_000, 1_090_000_001, 162_000_000, 1_090_000_000,
			])
				h.tuner.applyExternalCommand("s", 1, hz)
			expect(h.events).toHaveLength(2)
			expect(h.events[0]).toMatchObject({
				skipped: "external-control",
				link: h.link,
			})
			h.policy.reset("s")
			h.tuner.applyExternalCommand("s", 1, 1_090_000_000)
			h.tuner.setControlMode("s", "internal")
			h.tuner.applyExternalCommand("s", 1, 1_090_000_000)
			expect(h.events).toHaveLength(4)
			expect(h.commands).toEqual([])
		} finally {
			await h.close()
		}
	})
	it("external REST rejects before hook; throwing relay hooks are isolated", async () => {
		const h = await harness()
		try {
			h.tuner.setControlMode("s", "external")
			await expect(
				h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" }),
			).rejects.toThrow()
			h.tuner.setOnRelayRetune(() => {
				throw new WaveKitError("private", "TEST")
			})
			expect(() =>
				h.tuner.applyExternalCommand("s", 1, 1_090_000_000),
			).not.toThrow()
			expect(h.commands).toEqual([])
			expect(h.events).toEqual([])
		} finally {
			await h.close()
		}
	})
	it("failed raise propagates without frequency or record", async () => {
		const h = await harness()
		try {
			h.setFail()
			await expect(
				h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" }),
			).rejects.toThrow()
			expect(h.commands).toEqual([])
			expect(h.policy.recordFor("s")).toBeUndefined()
			expect(h.events[0]?.skipped).toBe("write-failed")
		} finally {
			await h.close()
		}
	})
	it.each(["scanner", "config", "replay"] as const)(
		"%s never invokes policy",
		async origin => {
			const h = await harness()
			try {
				await h.tuner.setFrequency("s", 1_090_000_000, { origin })
				expect(h.commands).toEqual([[1, 1_090_000_000]])
				expect(h.events).toEqual([])
			} finally {
				await h.close()
			}
		},
	)
	it("off restores on next REST retune; own device never raises", async () => {
		const h = await harness()
		try {
			h.setOwn(true)
			await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			expect(h.events).toEqual([])
			h.setOwn(false)
			await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			h.setMode("off")
			await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			expect(h.events.map(e => e.action)).toEqual(["raised", "restored"])
		} finally {
			await h.close()
		}
	})
	it.each([2_400_000, 3_200_000])("rate %i is never lowered", async rate => {
		const h = await harness()
		try {
			await h.tuner.setSampleRate("s", rate, { origin: "rest" })
			await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			expect(h.events).toHaveLength(rate === 3_200_000 ? 1 : 0)
			if (rate > 2_400_000) expect(h.events[0]?.skipped).toBe("rate-above")
		} finally {
			await h.close()
		}
	})
	it("disabled policy is silent", async () => {
		const h = await harness(false)
		try {
			await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			h.tuner.applyExternalCommand("s", 1, 1_090_000_000)
			expect(h.events).toEqual([])
		} finally {
			await h.close()
		}
	})
})

it.each(["off", "own", "equal", "above", "disabled"] as const)(
	"relay eligibility: %s",
	async kind => {
		const h = await harness(kind !== "disabled")
		try {
			if (kind === "off") h.setMode("off")
			if (kind === "own") h.setOwn(true)
			if (kind === "equal" || kind === "above")
				h.tuner.applyExternalCommand(
					"s",
					2,
					kind === "equal" ? 2_400_000 : 3_200_000,
				)
			h.tuner.applyExternalCommand("s", 1, 1_090_000_000)
			expect(h.commands).toEqual([])
			expect(h.events).toHaveLength(kind === "above" ? 1 : 0)
			if (kind === "above") expect(h.events[0]?.skipped).toBe("rate-above")
		} finally {
			await h.close()
		}
	},
)

it("failed restore retains the record and prevents frequency write", async () => {
	const h = await harness()
	try {
		await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
		h.setFail()
		await expect(
			h.tuner.setFrequency("s", 162_000_000, { origin: "rest" }),
		).rejects.toThrow()
		expect(h.commands).toHaveLength(2)
		expect(h.policy.recordFor("s")?.raisedFromHz).toBe(2_048_000)
		expect(h.events[1]?.skipped).toBe("write-failed")
	} finally {
		await h.close()
	}
})

it("bulk REST retunes raise before proof; an unchanged centre still proves its rate", async () => {
	const h = await harness()
	try {
		await h.tuner.setFrequency("s", 162_000_000, { origin: "scanner" })
		await h.tuner.configure("s", { frequency: 162_000_000 }, { origin: "rest" })
		expect(h.commands).toEqual([
			[1, 162_000_000],
			[2, 2_048_000],
		])
		await h.tuner.configure(
			"s",
			{ frequency: 1_090_000_000 },
			{ origin: "rest" },
		)
		expect(h.commands.slice(2)).toEqual([
			[2, 2_400_000],
			[1, 1_090_000_000],
		])
	} finally {
		await h.close()
	}
})

it("unchanged bulk REST frequency restores when readsb becomes off", async () => {
	const h = await harness()
	try {
		await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
		let lastState = h.tuner.getState("s")
		h.tuner.on("state-changed", (_id: string, state: TunerState) => {
			lastState = state
		})
		h.setMode("off")
		await h.tuner.configure(
			"s",
			{ frequency: 1_090_000_000 },
			{ origin: "rest" },
		)
		expect(h.commands.slice(2)).toEqual([[2, 2_048_000]])
		expect(h.policy.recordFor("s")).toBeUndefined()
		expect(lastState?.ratePolicy).toBeUndefined()
		expect(h.events.map(event => event.action)).toEqual(["raised", "restored"])
	} finally {
		await h.close()
	}
})

it.each([false, true])(
	"explicit bulk REST rate wins, already raised: %s",
	async raised => {
		const h = await harness()
		try {
			await h.tuner.setSampleRate("s", 2_048_000, { origin: "rest" })
			if (raised)
				await h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" })
			await h.tuner.configure(
				"s",
				{ frequency: 1_090_000_000, sampleRate: 2_400_000 },
				{ origin: "rest" },
			)
			expect(h.policy.recordFor("s")).toBeUndefined()
			expect(h.events.filter(event => event.action === "raised")).toHaveLength(
				raised ? 1 : 0,
			)
			const count = h.commands.length
			await h.tuner.setFrequency("s", 162_000_000, { origin: "rest" })
			expect(h.commands.slice(count)).toEqual([[1, 162_000_000]])
			expect(h.tuner.getState("s")?.sampleRate).toBe(2_400_000)
		} finally {
			await h.close()
		}
	},
)

it("observed peer drop on the rate command rejects the asynchronous tuner port before frequency", async () => {
	const h = await harness(true, true)
	try {
		await expect(
			h.tuner.setFrequency("s", 1_090_000_000, { origin: "rest" }),
		).rejects.toMatchObject({ code: "ECONNRESET" })
		const wire = Buffer.concat(h.received)
		expect(wire.length).toBe(5)
		expect(wire.readUInt8(0)).toBe(2)
		expect(wire.readUInt32BE(1)).toBe(2_400_000)
		expect(h.policy.recordFor("s")).toBeUndefined()
		expect(h.events[0]?.skipped).toBe("write-failed")
	} finally {
		await h.close()
	}
})

it.each(["operator", "reset", "dispose"] as const)(
	"a pending raise cannot resurrect a record after %s",
	async invalidation => {
		let release = () => {}
		const pending = new Promise<void>(resolve => {
			release = resolve
		})
		let rate = 2_048_000
		const writes: number[] = []
		const events: TunerRatePolicyEventData[] = []
		const reports: LinkAdvisory[] = []
		const tuner = {
			sampleRateOf: () => rate,
			controlModeOf: () => "internal" as const,
			async setSampleRate(_id: string, hz: number, opts: TunerWriteOptions) {
				rate = hz
				writes.push(hz)
				if (opts.origin === "decoder-rate") await pending
			},
		}
		const policy = createRatePolicy({
			port: { readsbOn: () => ({ mode: "auto", ownDevice: false }) },
			tuner,
			link: null,
			linkInput: () => null,
			upstreamDropsOf: () => null,
			reportLink: (_id, advisory) => {
				reports.push(advisory)
			},
			setTimer: () => ({ cancel() {} }),
			emit: event => {
				events.push(event)
			},
			now: () => new Date(0),
			log: createLogger({ level: "fatal" }),
			enabled: true,
		})
		const raise = policy.beforeOperatorRetune("s", 1_090_000_000, {
			origin: "rest",
		})
		try {
			expect(writes).toEqual([2_400_000])
			if (invalidation === "operator") {
				await tuner.setSampleRate("s", 3_200_000, { origin: "rest" })
				policy.onOperatorSampleRate("s")
			} else if (invalidation === "reset") policy.reset("s")
			else policy.dispose()
			release()
			await raise
			expect(policy.recordFor("s")).toBeUndefined()
			expect(events).toEqual([])
			expect(reports).toEqual([])
			const beforeLeaving = [...writes]
			await policy.beforeOperatorRetune("s", 162_000_000, { origin: "rest" })
			expect(writes).toEqual(beforeLeaving)
			if (invalidation === "operator") expect(rate).toBe(3_200_000)
		} finally {
			release()
			await raise
			policy.dispose()
		}
	},
)
