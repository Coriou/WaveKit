/**
 * Tests for DegradedModeMonitor
 *
 * Requirements tested:
 * - 10.5: Log warning every 60 seconds while degraded, stop when resolved
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { DegradedModeMonitor } from "../../../src/utils/degraded-mode-monitor.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { Logger } from "../../../src/utils/logger.js"
import type { DecoderHealth } from "../../../src/decoders/types.js"

// Mock logger
const createMockLogger = (): Logger => {
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(() => logger),
		level: "info",
		silent: vi.fn(),
	} as unknown as Logger
	return logger
}

// Mock DecoderManager
const createMockDecoderManager = (
	healthMap: Map<string, DecoderHealth>,
): DecoderManager => {
	return {
		getAllHealth: vi.fn(() => healthMap),
	} as unknown as DecoderManager
}

// Mock SourceManager
const createMockSourceManager = (degradedInfo: {
	isDegraded: boolean
	isAllUnavailable: boolean
	connectedSources: string[]
	disconnectedSources: string[]
	totalSources: number
}): SourceManager => {
	return {
		getDegradedInfo: vi.fn(() => degradedInfo),
	} as unknown as SourceManager
}

describe("DegradedModeMonitor", () => {
	let logger: Logger

	beforeEach(() => {
		vi.useFakeTimers()
		logger = createMockLogger()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("isDegraded()", () => {
		it("should return false when all decoders are running and all sources connected", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "running"],
				["decoder2", "running"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
			)

			expect(monitor.isDegraded()).toBe(false)
		})

		it("should return true when a decoder is degraded", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "running"],
				["decoder2", "degraded"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
			)

			expect(monitor.isDegraded()).toBe(true)
		})

		it("should return true when a decoder is faulted", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "running"],
				["decoder2", "faulted"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
			)

			expect(monitor.isDegraded()).toBe(true)
		})

		it("should return true when sources are degraded", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "running"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: true,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: ["source2"],
				totalSources: 2,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
			)

			expect(monitor.isDegraded()).toBe(true)
		})
	})

	describe("getState()", () => {
		it("should return detailed degraded state information", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "running"],
				["decoder2", "degraded"],
				["decoder3", "faulted"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: true,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: ["source2"],
				totalSources: 2,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
			)

			const state = monitor.getState()

			expect(state.isDecodersDegraded).toBe(true)
			expect(state.isSourcesDegraded).toBe(true)
			expect(state.degradedDecoders).toEqual(["decoder2"])
			expect(state.faultedDecoders).toEqual(["decoder3"])
			expect(state.disconnectedSources).toEqual(["source2"])
		})
	})

	describe("Periodic warnings (Requirement 10.5)", () => {
		it("should log warning when started in degraded mode", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "degraded"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
				{ warningInterval: 1000 },
			)

			monitor.start()

			// Should log warning immediately on start
			expect(logger.warn).toHaveBeenCalled()

			monitor.stop()
		})

		it("should log warning every interval while degraded", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "degraded"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
				{ warningInterval: 1000 },
			)

			monitor.start()

			// Initial warning
			expect(logger.warn).toHaveBeenCalledTimes(1)

			// Advance time by 1 second
			vi.advanceTimersByTime(1000)
			expect(logger.warn).toHaveBeenCalledTimes(2)

			// Advance time by another second
			vi.advanceTimersByTime(1000)
			expect(logger.warn).toHaveBeenCalledTimes(3)

			monitor.stop()
		})

		it("should not log warning when not degraded", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "running"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
				{ warningInterval: 1000 },
			)

			monitor.start()

			// Should not log warning when healthy
			expect(logger.warn).not.toHaveBeenCalled()

			// Advance time
			vi.advanceTimersByTime(1000)
			expect(logger.warn).not.toHaveBeenCalled()

			monitor.stop()
		})

		it("should log recovery message when degraded condition resolves", () => {
			let isDegraded = true
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "degraded"],
			])
			const decoderManager = {
				getAllHealth: vi.fn(() => {
					if (isDegraded) {
						return new Map([["decoder1", "degraded"]])
					}
					return new Map([["decoder1", "running"]])
				}),
			} as unknown as DecoderManager
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
				{ warningInterval: 1000 },
			)

			monitor.start()

			// Initial warning
			expect(logger.warn).toHaveBeenCalledTimes(1)

			// Resolve degraded condition
			isDegraded = false

			// Advance time
			vi.advanceTimersByTime(1000)

			// Should log recovery message
			expect(logger.info).toHaveBeenCalledWith(
				"System has recovered from degraded state - all components operational",
			)

			monitor.stop()
		})

		it("should stop logging warnings after stop() is called", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "degraded"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
				{ warningInterval: 1000 },
			)

			monitor.start()
			expect(logger.warn).toHaveBeenCalledTimes(1)

			monitor.stop()

			// Advance time - should not log more warnings
			vi.advanceTimersByTime(5000)
			expect(logger.warn).toHaveBeenCalledTimes(1)
		})
	})

	describe("Configuration", () => {
		it("should use default warning interval of 60 seconds", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "degraded"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
			)

			monitor.start()

			// Initial warning
			expect(logger.warn).toHaveBeenCalledTimes(1)

			// Advance by 59 seconds - should not log again
			vi.advanceTimersByTime(59000)
			expect(logger.warn).toHaveBeenCalledTimes(1)

			// Advance by 1 more second (total 60s) - should log again
			vi.advanceTimersByTime(1000)
			expect(logger.warn).toHaveBeenCalledTimes(2)

			monitor.stop()
		})

		it("should allow disabling decoder monitoring", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "degraded"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: false,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: [],
				totalSources: 1,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
				{ monitorDecoders: false, warningInterval: 1000 },
			)

			// Should not be degraded since decoder monitoring is disabled
			expect(monitor.isDegraded()).toBe(false)
		})

		it("should allow disabling source monitoring", () => {
			const decoderHealth = new Map<string, DecoderHealth>([
				["decoder1", "running"],
			])
			const decoderManager = createMockDecoderManager(decoderHealth)
			const sourceManager = createMockSourceManager({
				isDegraded: true,
				isAllUnavailable: false,
				connectedSources: ["source1"],
				disconnectedSources: ["source2"],
				totalSources: 2,
			})

			const monitor = new DegradedModeMonitor(
				logger,
				decoderManager,
				sourceManager,
				{ monitorSources: false, warningInterval: 1000 },
			)

			// Should not be degraded since source monitoring is disabled
			expect(monitor.isDegraded()).toBe(false)
		})
	})
})
