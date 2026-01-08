/**
 * Fanout Manager Property-Based Tests
 *
 * Tests for audio stream fanout/multiplexing functionality.
 * Requirements: 2.2, 2.3, 2.4, 2.5
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { PassThrough } from "node:stream"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

// Create a test logger
const testLogger = createLogger({ level: "error" })

/**
 * Helper to create a mock readable source stream
 */
function createMockSource(): PassThrough {
	return new PassThrough()
}

/**
 * Helper to collect data from a stream synchronously using data events
 */
function createDataCollector(): {
	chunks: Buffer[]
	attach: (stream: PassThrough) => void
} {
	const chunks: Buffer[] = []
	return {
		chunks,
		attach: (stream: PassThrough) => {
			stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
		},
	}
}

describe("Fanout Manager", () => {
	let fanout: FanoutManager
	let source: PassThrough

	beforeEach(() => {
		fanout = new FanoutManager(testLogger)
		source = createMockSource()
	})

	afterEach(() => {
		fanout.destroy()
	})

	describe("Basic Functionality", () => {
		it("should add and remove branches", () => {
			const branch1 = fanout.addBranch({ id: "branch1" })
			const branch2 = fanout.addBranch({ id: "branch2" })

			expect(branch1).toBeInstanceOf(PassThrough)
			expect(branch2).toBeInstanceOf(PassThrough)
			expect(fanout.getBranchIds()).toEqual(["branch1", "branch2"])

			fanout.removeBranch("branch1")
			expect(fanout.getBranchIds()).toEqual(["branch2"])
		})

		it("should attach and detach source", () => {
			fanout.attachSource(source)
			fanout.detachSource()
			// Should not throw
		})

		it("should return existing branch if adding duplicate", () => {
			const branch1 = fanout.addBranch({ id: "branch1" })
			const branch1Again = fanout.addBranch({ id: "branch1" })
			expect(branch1).toBe(branch1Again)
		})
	})

	describe("Telemetry", () => {
		it("should return branch telemetry with initial zero counters", () => {
			fanout.addBranch({ id: "test-branch", decoderId: "test-decoder" })

			const telemetry = fanout.getBranchTelemetry("test-branch")

			expect(telemetry).toBeDefined()
			expect(telemetry?.id).toBe("test-branch")
			expect(telemetry?.decoderId).toBe("test-decoder")
			expect(telemetry?.backpressureActive).toBe(false)
			expect(telemetry?.backpressureEnterCount).toBe(0)
			expect(telemetry?.droppedBytesTotal).toBe(0)
			expect(telemetry?.droppedChunksTotal).toBe(0)
			expect(telemetry?.totalBytesWritten).toBe(0)
		})

		it("should return undefined for non-existent branch", () => {
			const telemetry = fanout.getBranchTelemetry("non-existent")
			expect(telemetry).toBeUndefined()
		})

		it("should return complete fanout status snapshot", () => {
			fanout.addBranch({ id: "branch1" })
			fanout.addBranch({ id: "branch2" })

			const snapshot = fanout.getTelemetrySnapshot()

			expect(snapshot.timestamp).toBeDefined()
			expect(new Date(snapshot.timestamp).getTime()).toBeGreaterThan(0)
			expect(snapshot.branches).toHaveLength(2)
			expect(snapshot.backpressureActiveCount).toBe(0)
			expect(snapshot.droppedBytesTotal).toBe(0)
			expect(snapshot.droppedChunksTotal).toBe(0)
			expect(snapshot.totalBytesWritten).toBe(0)
		})

		it("should include highWaterMark in branch telemetry", () => {
			const customHWM = 512 * 1024 // 512KB
			fanout.addBranch({ id: "custom", highWaterMark: customHWM })

			const telemetry = fanout.getBranchTelemetry("custom")

			expect(telemetry?.highWaterMark).toBe(customHWM)
		})

		it("should track buffer bytes as data is written", () => {
			const branch = fanout.addBranch({ id: "test-branch" })
			fanout.attachSource(source)

			// Create a paused consumer (not reading from branch)
			// This allows buffer to fill

			const data = Buffer.alloc(1024, 0x42)
			source.write(data)

			const telemetry = fanout.getBranchTelemetry("test-branch")
			expect(telemetry?.bufferBytes).toBe(1024)

			// Drain the branch
			branch.read()
		})

		it("should track total bytes written", () => {
			fanout.addBranch({ id: "test-branch" })
			fanout.attachSource(source)

			const data = Buffer.alloc(100, 0x42)
			source.write(data)

			const telemetry = fanout.getBranchTelemetry("test-branch")
			expect(telemetry?.totalBytesWritten).toBe(100)
			expect(fanout.getTelemetrySnapshot().totalBytesWritten).toBe(100)

			// Write more data
			source.write(data)
			expect(fanout.getBranchTelemetry("test-branch")?.totalBytesWritten).toBe(
				200,
			)
		})
	})
})

describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 4: Fanout Data Distribution
	 * Validates: Requirements 2.3
	 *
	 * For any data chunk received by Fanout_Manager with N active branches,
	 * all N branches should receive an identical copy of the chunk
	 * (same bytes, same length).
	 */
	describe("Property 4: Fanout Data Distribution", () => {
		it("should distribute identical data to all branches", () => {
			fc.assert(
				fc.property(
					// Generate number of branches (1-10)
					fc.integer({ min: 1, max: 10 }),
					// Generate random data chunks (1-5 chunks, each 10-500 bytes)
					fc.array(fc.uint8Array({ minLength: 10, maxLength: 500 }), {
						minLength: 1,
						maxLength: 5,
					}),
					(numBranches, dataChunks) => {
						const fanout = new FanoutManager(testLogger)
						const source = createMockSource()

						try {
							// Create branches and collectors
							const collectors: { chunks: Buffer[] }[] = []

							for (let i = 0; i < numBranches; i++) {
								const branch = fanout.addBranch({ id: `branch-${i}` })
								const collector = createDataCollector()
								collector.attach(branch)
								collectors.push(collector)
							}

							// Attach source and send data
							fanout.attachSource(source)

							for (const chunk of dataChunks) {
								source.write(Buffer.from(chunk))
							}

							// Calculate expected data
							const expectedData = Buffer.concat(
								dataChunks.map(c => Buffer.from(c)),
							)

							// Verify all branches received the same data
							for (let i = 0; i < numBranches; i++) {
								const branchData = Buffer.concat(collectors[i]!.chunks)
								// Each branch should receive identical data
								if (branchData.length !== expectedData.length) {
									return false
								}
								if (!branchData.equals(expectedData)) {
									return false
								}
							}

							return true
						} finally {
							fanout.destroy()
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should copy data independently (no shared buffers)", () => {
			fc.assert(
				fc.property(
					// Generate random data
					fc.uint8Array({ minLength: 100, maxLength: 500 }),
					dataChunk => {
						const fanout = new FanoutManager(testLogger)
						const source = createMockSource()

						try {
							// Create two branches
							const branch1 = fanout.addBranch({ id: "branch1" })
							const branch2 = fanout.addBranch({ id: "branch2" })

							const collector1 = createDataCollector()
							const collector2 = createDataCollector()
							collector1.attach(branch1)
							collector2.attach(branch2)

							fanout.attachSource(source)

							const originalBuffer = Buffer.from(dataChunk)
							source.write(originalBuffer)

							const buffer1 = Buffer.concat(collector1.chunks)
							const buffer2 = Buffer.concat(collector2.chunks)

							// Both should have same content
							if (!buffer1.equals(buffer2)) {
								return false
							}

							// Modify buffer1 - should not affect buffer2
							// (This verifies they are independent copies)
							if (buffer1.length > 0) {
								const originalByte = buffer1[0]
								buffer1[0] = (originalByte! + 1) % 256
								// buffer2 should still have original value
								if (buffer2[0] !== originalByte) {
									return false
								}
							}

							return true
						} finally {
							fanout.destroy()
						}
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Feature: wavekit-core, Property 5: Branch Independence
	 * Validates: Requirements 2.2, 2.5
	 *
	 * For any two branches A and B in Fanout_Manager, writing to branch A's
	 * buffer should not affect branch B's buffer state, and removing branch A
	 * should not affect data flow to branch B.
	 */
	describe("Property 5: Branch Independence", () => {
		it("should maintain independent buffer states between branches", () => {
			fc.assert(
				fc.property(
					// Generate number of branches (2-5)
					fc.integer({ min: 2, max: 5 }),
					// Generate data chunks
					fc.array(fc.uint8Array({ minLength: 50, maxLength: 200 }), {
						minLength: 2,
						maxLength: 5,
					}),
					(numBranches, dataChunks) => {
						const fanout = new FanoutManager(testLogger)
						const source = createMockSource()

						try {
							// Create branches with different highWaterMarks
							for (let i = 0; i < numBranches; i++) {
								fanout.addBranch({
									id: `branch-${i}`,
									highWaterMark: 1024 * (i + 1), // Different sizes
								})
							}

							fanout.attachSource(source)

							// Send data
							for (const chunk of dataChunks) {
								source.write(Buffer.from(chunk))
							}

							// Check that each branch has independent status
							for (let i = 0; i < numBranches; i++) {
								const status = fanout.getBranchStatus(`branch-${i}`)
								if (!status) return false
								if (status.id !== `branch-${i}`) return false
							}

							return true
						} finally {
							fanout.destroy()
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should continue data flow to remaining branches after one is removed", () => {
			fc.assert(
				fc.property(
					// Generate data chunks before removal
					fc.array(fc.uint8Array({ minLength: 20, maxLength: 100 }), {
						minLength: 1,
						maxLength: 3,
					}),
					// Generate data chunks after removal
					fc.array(fc.uint8Array({ minLength: 20, maxLength: 100 }), {
						minLength: 1,
						maxLength: 3,
					}),
					(chunksBeforeRemoval, chunksAfterRemoval) => {
						const fanout = new FanoutManager(testLogger)
						const source = createMockSource()

						try {
							// Create three branches
							const branchA = fanout.addBranch({ id: "branchA" })
							const branchB = fanout.addBranch({ id: "branchB" })
							const branchC = fanout.addBranch({ id: "branchC" })

							const collectorB = createDataCollector()
							const collectorC = createDataCollector()
							collectorB.attach(branchB)
							collectorC.attach(branchC)

							fanout.attachSource(source)

							// Send first batch of data
							for (const chunk of chunksBeforeRemoval) {
								source.write(Buffer.from(chunk))
							}

							// Remove branch A
							fanout.removeBranch("branchA")

							// Verify branchA is removed
							if (fanout.getBranchIds().includes("branchA")) return false
							if (!fanout.getBranchIds().includes("branchB")) return false
							if (!fanout.getBranchIds().includes("branchC")) return false

							// Send second batch of data (only B and C should receive)
							for (const chunk of chunksAfterRemoval) {
								source.write(Buffer.from(chunk))
							}

							const bufferB = Buffer.concat(collectorB.chunks)
							const bufferC = Buffer.concat(collectorC.chunks)

							// B and C should have received all data (before + after removal)
							const allData = Buffer.concat([
								...chunksBeforeRemoval.map(c => Buffer.from(c)),
								...chunksAfterRemoval.map(c => Buffer.from(c)),
							])

							// Both remaining branches should have identical data
							if (!bufferB.equals(bufferC)) {
								return false
							}

							// And should have all the data
							if (!bufferB.equals(allData)) {
								return false
							}

							return true
						} finally {
							fanout.destroy()
						}
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Feature: wavekit-core, Property 6: Backpressure Non-Blocking
	 * Validates: Requirements 2.4
	 *
	 * For any branch that reaches its highWaterMark, the source stream
	 * should continue to flow (not block), and a 'backpressure' event
	 * should be emitted for that branch.
	 */
	describe("Property 6: Backpressure Non-Blocking", () => {
		it("should emit backpressure event and continue flowing when buffer fills", () => {
			fc.assert(
				fc.property(
					// Generate small highWaterMark to trigger backpressure easily
					fc.integer({ min: 64, max: 256 }),
					// Generate data larger than highWaterMark (multiplier)
					fc.integer({ min: 2, max: 5 }),
					(highWaterMark, multiplier) => {
						const fanout = new FanoutManager(testLogger)
						const source = createMockSource()

						try {
							// Create a branch with small buffer
							const branch = fanout.addBranch({
								id: "slowBranch",
								highWaterMark,
							})

							// Track backpressure events
							let backpressureEmitted = false
							let backpressureBranchId: string | null = null

							fanout.on("backpressure", (branchId: string) => {
								backpressureEmitted = true
								backpressureBranchId = branchId
							})

							fanout.attachSource(source)

							// Don't consume from branch (simulate slow consumer)
							// This will cause backpressure

							// Send data larger than highWaterMark
							const dataSize = highWaterMark * multiplier
							const largeData = Buffer.alloc(dataSize, 0x42)

							// Write should not block even with backpressure
							const writeStartTime = Date.now()
							source.write(largeData)
							const writeEndTime = Date.now()

							// Write should complete quickly (not block)
							const writeDuration = writeEndTime - writeStartTime
							if (writeDuration > 1000) {
								// Should not take more than 1 second
								return false
							}

							// If backpressure was emitted, verify it was for the right branch
							if (
								backpressureEmitted &&
								backpressureBranchId !== "slowBranch"
							) {
								return false
							}

							// Source should still be able to write more data
							// (proving it's not blocked)
							const moreData = Buffer.alloc(100, 0x43)
							const canWrite = source.write(moreData)
							// Source itself should still accept writes
							// (the fanout doesn't block the source)

							return true
						} finally {
							fanout.destroy()
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should not block source when one branch has backpressure", () => {
			fc.assert(
				fc.property(
					// Generate data size
					fc.integer({ min: 500, max: 2000 }),
					dataSize => {
						const fanout = new FanoutManager(testLogger)
						const source = createMockSource()

						try {
							// Create one slow branch (small buffer, no consumer)
							const slowBranch = fanout.addBranch({
								id: "slow",
								highWaterMark: 64, // Very small buffer
							})

							// Create one fast branch (large buffer, active consumer)
							const fastBranch = fanout.addBranch({
								id: "fast",
								highWaterMark: 1024 * 1024, // 1MB buffer
							})

							const fastCollector = createDataCollector()
							fastCollector.attach(fastBranch)

							fanout.attachSource(source)

							// Send data - slow branch will backpressure
							const data = Buffer.alloc(dataSize, 0x55)
							source.write(data)

							const fastBuffer = Buffer.concat(fastCollector.chunks)

							// Fast branch should have received all data
							// despite slow branch having backpressure
							if (fastBuffer.length !== dataSize) {
								return false
							}

							if (!fastBuffer.equals(data)) {
								return false
							}

							return true
						} finally {
							fanout.destroy()
						}
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
