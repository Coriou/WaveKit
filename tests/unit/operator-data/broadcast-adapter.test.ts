import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OperatorDataReadDto } from "@wavekit/api-types"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createOperatorDataCommitSink,
	sendOperatorDataSnapshot,
} from "../../../src/operator-data/broadcast-adapter.js"
import type { OperatorDataBroadcastPort } from "../../../src/operator-data/broadcast-adapter.js"
import { snapshotToken } from "../../../src/operator-data/domain.js"
import { OperatorDataError } from "../../../src/operator-data/schema.js"
import { OperatorDataService } from "../../../src/operator-data/service.js"
import { toOperatorDataWriteDto } from "../../../src/operator-data/transport.js"

const roots: string[] = []
const services: OperatorDataService[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const service of services.splice(0)) await service.close()
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true })
})
async function open(port: OperatorDataBroadcastPort) {
	const stateDir = await mkdtemp(join(tmpdir(), "wavekit-operator-broadcast-"))
	roots.push(stateDir)
	const service = await OperatorDataService.open({
		stateDir,
		onCommit: createOperatorDataCommitSink(port),
	})
	services.push(service)
	return { service, stateDir }
}
function port() {
	return {
		publishUpdated: vi.fn<(data: OperatorDataReadDto) => void>(),
		sendSnapshot: vi.fn<(id: string, data: OperatorDataReadDto) => boolean>(
			() => true,
		),
	}
}

describe("pure injected operator-data broadcast adapters (Requirements 5.2, 3.3)", () => {
	it("maps detached full state synchronously and explicitly returns undefined", async () => {
		const output = port()
		const { service } = await open(output)
		const snapshot = service.snapshot()
		output.publishUpdated.mockImplementation(data => {
			expect(data.snapshot).toEqual(snapshot)
			expect(data.capabilities).toEqual({
				toneSelection: true,
				toneDetection: false,
				toneSquelch: false,
			})
			data.snapshot.preferenceOverrides.units = "imperial"
			data.preferences.values.units = "metric"
		})
		const sink = createOperatorDataCommitSink(output)
		expect(sink(snapshot)).toBeUndefined()
		expect(output.publishUpdated).toHaveBeenCalledOnce()
		expect(snapshot.preferenceOverrides).toEqual({})
		expect(service.snapshot().preferenceOverrides).toEqual({})
		expect(output.sendSnapshot).not.toHaveBeenCalled()
	})

	it.each([true, false])(
		"forwards bounded snapshot acceptance %s unchanged with detached data",
		async accepted => {
			const output = port()
			const { service } = await open(output)
			output.sendSnapshot.mockImplementation((id, data) => {
				expect(id).toBe("authorized-client")
				expect(data.snapshot).toEqual(service.snapshot())
				data.snapshot.revision = 999
				return accepted
			})
			expect(
				sendOperatorDataSnapshot(service, output, "authorized-client"),
			).toBe(accepted)
			expect(service.snapshot().revision).toBe(0)
			expect(output.sendSnapshot).toHaveBeenCalledOnce()
			expect(output.publishUpdated).not.toHaveBeenCalled()
		},
	)

	it("captures/enqueues initial state before a later commit and publishes before resolution; noop publishes nothing", async () => {
		const output = port()
		const events: string[] = []
		const { service } = await open(output)
		output.sendSnapshot.mockImplementation((_id, data) => {
			events.push(`snapshot:${data.snapshot.revision}`)
			return true
		})
		output.publishUpdated.mockImplementation(data => {
			expect(service.snapshot()).toEqual(data.snapshot)
			events.push(`updated:${data.snapshot.revision}`)
			data.snapshot.preferenceOverrides.units = "imperial"
		})
		// Owner registration is modeled only; actual observer/authorization wiring is separate.
		events.push("registered")
		expect(sendOperatorDataSnapshot(service, output, "client")).toBe(true)
		events.push("captured")
		const result = await service.mutate({
			type: "patch-preferences",
			expected: snapshotToken(service.snapshot()),
			set: { units: "metric" },
		})
		events.push("resolved")
		expect(events).toEqual([
			"registered",
			"snapshot:0",
			"captured",
			"updated:1",
			"resolved",
		])
		expect(result.snapshot.preferenceOverrides.units).toBe("metric")
		expect(result.delivery).toBe("sent")
		await service.mutate({
			type: "patch-preferences",
			expected: snapshotToken(service.snapshot()),
			set: { units: "metric" },
		})
		expect(output.publishUpdated).toHaveBeenCalledOnce()
	})

	it("propagates absent/unavailable capture, invalid mapping and port failures without empty snapshots", async () => {
		const output = port()
		const { service } = await open(output)
		expect(() => sendOperatorDataSnapshot(undefined, output, "client")).toThrow(
			new OperatorDataError("OPERATOR_DATA_UNAVAILABLE"),
		)
		const snapshot = service.snapshot()
		const sink = createOperatorDataCommitSink(output)
		expect(() =>
			sink({ ...snapshot, version: 2 } as unknown as typeof snapshot),
		).toThrow(new OperatorDataError("OPERATOR_DATA_INVALID"))
		const capture = vi.spyOn(service, "snapshot").mockImplementation(() => {
			throw new OperatorDataError("OPERATOR_DATA_UNAVAILABLE")
		})
		expect(() => sendOperatorDataSnapshot(service, output, "client")).toThrow(
			new OperatorDataError("OPERATOR_DATA_UNAVAILABLE"),
		)
		capture.mockReturnValue({
			...snapshot,
			version: 2,
		} as unknown as typeof snapshot)
		expect(() => sendOperatorDataSnapshot(service, output, "client")).toThrow(
			new OperatorDataError("OPERATOR_DATA_INVALID"),
		)
		expect(output.sendSnapshot).not.toHaveBeenCalled()
		expect(output.publishUpdated).not.toHaveBeenCalled()
		capture.mockRestore()
		const failure = new Error("owner port failed")
		output.sendSnapshot.mockImplementation(() => {
			throw failure
		})
		output.publishUpdated.mockImplementation(() => {
			throw failure
		})
		expect(() => sendOperatorDataSnapshot(service, output, "client")).toThrow(
			failure,
		)
		expect(() => sink(snapshot)).toThrow(failure)
	})

	it("keeps real durable success and public result when publication throws", async () => {
		const output = port()
		output.publishUpdated.mockImplementation(() => {
			throw new Error("transport failed")
		})
		const { service, stateDir } = await open(output)
		const result = await service.mutate({
			type: "patch-preferences",
			expected: snapshotToken(service.snapshot()),
			set: { units: "metric" },
		})
		expect(result.delivery).toBe("failed")
		expect(result.changed).toBe(true)
		expect(result.snapshot.revision).toBe(1)
		expect(
			JSON.parse(
				await readFile(join(stateDir, "operator-data", "state.json"), "utf8"),
			),
		).toEqual(service.snapshot())
		expect(toOperatorDataWriteDto(result)).toEqual({
			snapshot: service.snapshot(),
		})
		expect(sendOperatorDataSnapshot(service, output, "refetch-client")).toBe(
			true,
		)
	})
})
