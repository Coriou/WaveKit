/**
 * Beast Binary Format Sample Data Generator
 *
 * This file generates sample Beast binary data for testing.
 * Beast format uses:
 * - Escape byte: 0x1a
 * - Message types: 0x31 (Mode-AC), 0x32 (Mode-S short), 0x33 (Mode-S long)
 * - Format: <escape> <type> <timestamp 6 bytes> <signal 1 byte> <message>
 *
 * Run with: npx tsx tests/mocks/fixtures/adsb/beast-sample.ts
 */

import { writeFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Creates a Beast Mode-S short message (7 bytes payload).
 * @param icao - 6-character hex ICAO address
 * @param signal - Signal strength (0-255)
 */
function createBeastShortMessage(icao: string, signal: number = 100): Buffer {
	const escape = 0x1a
	const msgType = 0x32 // Mode-S short
	const timestamp = Buffer.alloc(6) // 6 bytes timestamp (zeros for sample)
	const icaoBytes = Buffer.from(icao, "hex")

	// Mode-S short message: DF byte + ICAO (3 bytes) + data (3 bytes)
	const message = Buffer.alloc(7)
	message[0] = 0x00 // DF byte
	icaoBytes.copy(message, 1) // ICAO in bytes 1-3

	return Buffer.concat([
		Buffer.from([escape, msgType]),
		timestamp,
		Buffer.from([signal]),
		message,
	])
}

/**
 * Creates a Beast Mode-S long message (14 bytes payload).
 * @param icao - 6-character hex ICAO address
 * @param signal - Signal strength (0-255)
 */
function createBeastLongMessage(icao: string, signal: number = 100): Buffer {
	const escape = 0x1a
	const msgType = 0x33 // Mode-S long
	const timestamp = Buffer.alloc(6) // 6 bytes timestamp (zeros for sample)
	const icaoBytes = Buffer.from(icao, "hex")

	// Mode-S long message: DF byte + ICAO (3 bytes) + data (10 bytes)
	const message = Buffer.alloc(14)
	message[0] = 0x00 // DF byte
	icaoBytes.copy(message, 1) // ICAO in bytes 1-3

	return Buffer.concat([
		Buffer.from([escape, msgType]),
		timestamp,
		Buffer.from([signal]),
		message,
	])
}

/**
 * Creates a Beast Mode-AC message (2 bytes payload).
 * Mode-AC messages don't contain ICAO addresses.
 */
function createBeastModeACMessage(signal: number = 100): Buffer {
	const escape = 0x1a
	const msgType = 0x31 // Mode-AC
	const timestamp = Buffer.alloc(6)
	const message = Buffer.alloc(2)

	return Buffer.concat([
		Buffer.from([escape, msgType]),
		timestamp,
		Buffer.from([signal]),
		message,
	])
}

// Generate sample Beast binary data
const messages: Buffer[] = [
	// Mode-S short messages with various ICAO addresses
	createBeastShortMessage("A12345", 150),
	createBeastShortMessage("ABCDEF", 120),
	createBeastShortMessage("789ABC", 180),
	createBeastShortMessage("DEF012", 90),
	createBeastShortMessage("345678", 200),

	// Mode-S long messages
	createBeastLongMessage("9ABCDE", 160),
	createBeastLongMessage("F12345", 140),
	createBeastLongMessage("E67890", 170),
	createBeastLongMessage("C0FFEE", 130),
	createBeastLongMessage("DEADBE", 110),

	// Mode-AC messages (should be ignored by parser)
	createBeastModeACMessage(100),
	createBeastModeACMessage(80),

	// More Mode-S messages
	createBeastShortMessage("BEEF01", 155),
	createBeastLongMessage("CAFE12", 145),
	createBeastShortMessage("123456", 165),
	createBeastLongMessage("FEDCBA", 135),
]

// Concatenate all messages
const beastData = Buffer.concat(messages)

// Write to binary file
const outputPath = join(__dirname, "beast-sample.bin")
writeFileSync(outputPath, beastData)

console.log(`Generated Beast sample data: ${outputPath}`)
console.log(`Total size: ${beastData.length} bytes`)
console.log(`Messages: ${messages.length}`)

// Also export the data for direct use in tests
export const BEAST_SAMPLE_DATA = beastData
export const BEAST_SAMPLE_MESSAGES = messages
export {
	createBeastShortMessage,
	createBeastLongMessage,
	createBeastModeACMessage,
}
