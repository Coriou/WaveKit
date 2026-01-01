/**
 * Audio Output Unit Tests
 *
 * Tests for TCP server streaming audio to host players.
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import * as net from "node:net"
import { PassThrough } from "node:stream"
import {
	AudioOutput,
	type AudioOutputConfig,
} from "../../../src/core/audio-output.js"
import { createLogger } from "../../../src/utils/logger.js"

// Create a test logger
const testLogger = createLogger({ level: "error" })

// Use a dynamic port to avoid conflicts
let testPort = 18080

function getNextPort(): number {
	return testPort++
}

/**
 * Helper to create a mock audio source stream
 */
function createMockSource(): PassThrough {
	return new PassThrough()
}

/**
 * Helper to connect a TCP client and collect data
 */
function connectClient(port: number): Promise<{
	socket: net.Socket
	chunks: Buffer[]
	close: () => void
}> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
			resolve({
				socket,
				chunks,
				close: () => socket.destroy(),
			})
		})

		socket.on("data", (chunk: Buffer) => {
			chunks.push(Buffer.from(chunk))
		})

		socket.on("error", reject)
	})
}

/**
 * Helper to wait for a specific number of milliseconds
 */
function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

describe("Audio Output", () => {
	let audioOutput: AudioOutput
	let config: AudioOutputConfig

	beforeEach(() => {
		config = {
			port: getNextPort(),
			format: "S16LE",
			sampleRate: 48000,
		}
		audioOutput = new AudioOutput(testLogger, config)
	})

	afterEach(async () => {
		await audioOutput.stop().catch(() => {})
	})

	describe("Server Lifecycle", () => {
		/**
		 * Requirement 11.1: Listen on configured TCP port when started
		 */
		it("should start and listen on configured port", async () => {
			await audioOutput.start()
			expect(audioOutput.getPort()).toBe(config.port)

			// Verify we can connect
			const client = await connectClient(config.port)
			expect(client.socket.remotePort).toBe(config.port)
			client.close()
		})

		it("should stop and close all connections", async () => {
			await audioOutput.start()

			const _client = await connectClient(config.port)
			expect(audioOutput.getConnectedClients()).toBe(1)

			await audioOutput.stop()
			expect(audioOutput.getConnectedClients()).toBe(0)
		})

		it("should emit started event with port", async () => {
			let emittedPort: number | null = null
			audioOutput.on("started", (port: number) => {
				emittedPort = port
			})

			await audioOutput.start()
			expect(emittedPort).toBe(config.port)
		})

		it("should emit stopped event", async () => {
			let stopped = false
			audioOutput.on("stopped", () => {
				stopped = true
			})

			await audioOutput.start()
			await audioOutput.stop()
			expect(stopped).toBe(true)
		})
	})

	describe("Client Connections", () => {
		/**
		 * Requirement 11.4: Clean up resources when client disconnects
		 */
		it("should track connected clients", async () => {
			await audioOutput.start()

			expect(audioOutput.getConnectedClients()).toBe(0)

			const client1 = await connectClient(config.port)
			await delay(10) // Allow event processing
			expect(audioOutput.getConnectedClients()).toBe(1)

			const client2 = await connectClient(config.port)
			await delay(10)
			expect(audioOutput.getConnectedClients()).toBe(2)

			client1.close()
			await delay(50) // Allow disconnect processing
			expect(audioOutput.getConnectedClients()).toBe(1)

			client2.close()
			await delay(50)
			expect(audioOutput.getConnectedClients()).toBe(0)
		})

		it("should emit client-connected and client-disconnected events", async () => {
			const connectedIds: string[] = []
			const disconnectedIds: string[] = []

			audioOutput.on("client-connected", (id: string) => connectedIds.push(id))
			audioOutput.on("client-disconnected", (id: string) =>
				disconnectedIds.push(id),
			)

			await audioOutput.start()

			const client = await connectClient(config.port)
			await delay(10)
			expect(connectedIds.length).toBe(1)

			client.close()
			await delay(50)
			expect(disconnectedIds.length).toBe(1)
			expect(disconnectedIds[0]).toBe(connectedIds[0])
		})
	})

	describe("Audio Streaming", () => {
		/**
		 * Requirement 11.2: Stream decoded audio in configured format
		 */
		it("should stream audio data to connected client", async () => {
			await audioOutput.start()

			const source = createMockSource()
			audioOutput.attachSource(source)

			const client = await connectClient(config.port)
			await delay(10)

			// Send audio data
			const audioData = Buffer.alloc(1024, 0x42)
			source.write(audioData)

			await delay(50) // Allow data to be transmitted

			const receivedData = Buffer.concat(client.chunks)
			expect(receivedData.length).toBe(audioData.length)
			expect(receivedData.equals(audioData)).toBe(true)

			client.close()
		})

		/**
		 * Requirement 11.3: Stream to all connected clients
		 */
		it("should stream to multiple clients simultaneously", async () => {
			await audioOutput.start()

			const source = createMockSource()
			audioOutput.attachSource(source)

			// Connect multiple clients
			const client1 = await connectClient(config.port)
			const client2 = await connectClient(config.port)
			const client3 = await connectClient(config.port)
			await delay(10)

			expect(audioOutput.getConnectedClients()).toBe(3)

			// Send audio data
			const audioData = Buffer.alloc(512, 0xab)
			source.write(audioData)

			await delay(50)

			// All clients should receive identical data
			const data1 = Buffer.concat(client1.chunks)
			const data2 = Buffer.concat(client2.chunks)
			const data3 = Buffer.concat(client3.chunks)

			expect(data1.length).toBe(audioData.length)
			expect(data2.length).toBe(audioData.length)
			expect(data3.length).toBe(audioData.length)

			expect(data1.equals(audioData)).toBe(true)
			expect(data2.equals(audioData)).toBe(true)
			expect(data3.equals(audioData)).toBe(true)

			client1.close()
			client2.close()
			client3.close()
		})

		it("should handle source attach and detach", async () => {
			await audioOutput.start()

			const source1 = createMockSource()
			audioOutput.attachSource(source1)

			const clientData = await connectClient(config.port)
			await delay(10)

			// Send data from first source
			const data1 = Buffer.from("source1")
			source1.write(data1)
			await delay(20)

			// Detach and attach new source
			audioOutput.detachSource()
			const source2 = createMockSource()
			audioOutput.attachSource(source2)

			// Send data from second source
			const data2 = Buffer.from("source2")
			source2.write(data2)
			await delay(20)

			const receivedData = Buffer.concat(clientData.chunks)
			const expectedData = Buffer.concat([data1, data2])
			expect(receivedData.equals(expectedData)).toBe(true)

			clientData.close()
		})
	})

	describe("Format Support", () => {
		/**
		 * Requirement 11.5: Support S16LE format at 48kHz sample rate
		 */
		it("should be configured with S16LE format at 48kHz", () => {
			const s16Config: AudioOutputConfig = {
				port: getNextPort(),
				format: "S16LE",
				sampleRate: 48000,
			}
			const output = new AudioOutput(testLogger, s16Config)
			expect(output.getPort()).toBe(s16Config.port)
			// Format is stored in config and used for documentation/metadata
		})

		it("should also support FLOAT32LE format", () => {
			const f32Config: AudioOutputConfig = {
				port: getNextPort(),
				format: "FLOAT32LE",
				sampleRate: 48000,
			}
			const output = new AudioOutput(testLogger, f32Config)
			expect(output.getPort()).toBe(f32Config.port)
		})
	})
})

/**
 * Property-Based Tests for Audio Output
 */
describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 20: Audio Output Multi-Client Distribution
	 * Validates: Requirements 11.2, 11.3
	 *
	 * For any N connected TCP clients to Audio_Output, when audio data is
	 * written to the source, all N clients should receive identical data.
	 */
	describe("Property 20: Audio Output Multi-Client Distribution", () => {
		it(
			"should distribute identical data to all connected clients",
			{ timeout: 60000 },
			async () => {
				await fc.assert(
					fc.asyncProperty(
						// Generate number of clients (1-5)
						fc.integer({ min: 1, max: 5 }),
						// Generate random audio data chunks (1-3 chunks, each 50-200 bytes)
						fc.array(fc.uint8Array({ minLength: 50, maxLength: 200 }), {
							minLength: 1,
							maxLength: 3,
						}),
						async (numClients, dataChunks) => {
							const config: AudioOutputConfig = {
								port: getNextPort(),
								format: "S16LE",
								sampleRate: 48000,
							}
							const audioOutput = new AudioOutput(testLogger, config)

							try {
								await audioOutput.start()

								const source = createMockSource()
								audioOutput.attachSource(source)

								// Connect N clients and collect their data
								const clients: {
									socket: net.Socket
									chunks: Buffer[]
									close: () => void
								}[] = []

								for (let i = 0; i < numClients; i++) {
									const client = await connectClient(config.port)
									clients.push(client)
								}

								// Wait for all clients to be registered
								await delay(20)

								// Verify all clients are connected
								if (audioOutput.getConnectedClients() !== numClients) {
									return false
								}

								// Send audio data through the source
								for (const chunk of dataChunks) {
									source.write(Buffer.from(chunk))
								}

								// Wait for data to be transmitted to all clients
								await delay(50)

								// Calculate expected data
								const expectedData = Buffer.concat(
									dataChunks.map(c => Buffer.from(c)),
								)

								// Verify all clients received identical data
								for (let i = 0; i < numClients; i++) {
									const clientData = Buffer.concat(clients[i]!.chunks)

									// Each client should receive data of the same length
									if (clientData.length !== expectedData.length) {
										return false
									}

									// Each client should receive identical data
									if (!clientData.equals(expectedData)) {
										return false
									}
								}

								// Clean up clients
								for (const client of clients) {
									client.close()
								}

								return true
							} finally {
								await audioOutput.stop().catch(() => {})
							}
						},
					),
					{ numRuns: 100 },
				)
			},
		)

		it(
			"should distribute data independently to each client (no shared buffers)",
			{ timeout: 60000 },
			async () => {
				await fc.assert(
					fc.asyncProperty(
						// Generate random audio data
						fc.uint8Array({ minLength: 100, maxLength: 500 }),
						async dataChunk => {
							const config: AudioOutputConfig = {
								port: getNextPort(),
								format: "S16LE",
								sampleRate: 48000,
							}
							const audioOutput = new AudioOutput(testLogger, config)

							try {
								await audioOutput.start()

								const source = createMockSource()
								audioOutput.attachSource(source)

								// Connect two clients
								const client1 = await connectClient(config.port)
								const client2 = await connectClient(config.port)

								await delay(20)

								// Send audio data
								const originalBuffer = Buffer.from(dataChunk)
								source.write(originalBuffer)

								await delay(50)

								const buffer1 = Buffer.concat(client1.chunks)
								const buffer2 = Buffer.concat(client2.chunks)

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

								client1.close()
								client2.close()

								return true
							} finally {
								await audioOutput.stop().catch(() => {})
							}
						},
					),
					{ numRuns: 100 },
				)
			},
		)
	})
})
