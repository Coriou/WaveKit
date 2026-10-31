/**
 * The Python wrapper (docker/scripts/lora_meshtastic_decode.py) against the synthetic on-air
 * Meshtastic frame in fixtures/lora: header parse, CRC gate, channel-PSK decrypt, Data parse
 * and the JSON line the adapter's schema accepts. The Python cases skip without python3; the
 * decrypt cases also need the `cryptography` and `protobuf` modules (installed in the image).
 */
import { spawnSync } from "node:child_process"
import { createDecipheriv, createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseMeshtasticPacket } from "../../../src/decoders/builtin/lora-meshtastic.js"

const FRAME = readFileSync(resolve("fixtures/lora/meshtastic_onair_frame.bin"))
const SCRIPT = resolve("docker/scripts/lora_meshtastic_decode.py")
const SELF_TEST = resolve("tests/unit/decoders/test_lora_meshtastic_decode.py")
/** Firmware default channel PSK: "AQ==" expands to it (Channels.cpp). */
const DEFAULT_PSK = Buffer.from("d4f1bb3a20290759f0bcffabcf4e6901", "hex")

function python(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync("python3", ["-I", ...args], {
		encoding: "utf8",
		timeout: 60_000,
	})
}

const hasPython = python(["-c", "pass"]).status === 0
const hasDecryptModules =
	hasPython &&
	python([
		"-c",
		`import sys; sys.path.insert(0, ${JSON.stringify(join(resolve("docker/scripts"), "meshtastic_proto"))}); import cryptography, mesh_pb2`,
	]).status === 0

describe("synthetic Meshtastic fixtures", () => {
	it("match their recorded sha256", () => {
		for (const dir of ["fixtures/lora", "fixtures/aprs"]) {
			const sums = readFileSync(resolve(dir, "SHA256SUMS"), "utf8")
				.trim()
				.split("\n")
			expect(sums.length).toBeGreaterThan(0)
			for (const line of sums) {
				const [sha, name] = line.split(/\s+/)
				expect(name, line).toBeDefined()
				const actual = createHash("sha256")
					.update(readFileSync(resolve(dir, name ?? "")))
					.digest("hex")
				expect(actual, `${dir}/${name}`).toBe(sha)
			}
		}
	})

	it("holds a 16-byte header plus AES-128-CTR Data under the default PSK", () => {
		expect(FRAME.length).toBe(33)
		expect(FRAME.readUInt32LE(0)).toBe(0xffffffff)
		expect(FRAME.readUInt32LE(4)).toBe(169_552_957)
		expect(FRAME.readUInt32LE(8)).toBe(305_419_896)
		expect(FRAME[12]).toBe(0x63)
		const nonce = Buffer.alloc(16)
		nonce.writeUInt32LE(FRAME.readUInt32LE(8), 0) // id as u64 LE (high word 0)
		nonce.writeUInt32LE(FRAME.readUInt32LE(4), 8) // from as u32 LE, then 4 zero bytes
		const decipher = createDecipheriv("aes-128-ctr", DEFAULT_PSK, nonce)
		const plain = Buffer.concat([
			decipher.update(FRAME.subarray(16)),
			decipher.final(),
		])
		// Data{portnum: 1 (field 1 varint), payload: "hello wavekit" (field 2, 13 bytes)}
		expect(plain.toString("hex")).toBe(
			`0801120d${Buffer.from("hello wavekit").toString("hex")}`,
		)
	})
})

describe.skipIf(!hasPython)("lora_meshtastic_decode.py", () => {
	it("compiles and passes its self-test", () => {
		const result = python([SELF_TEST, "-v"])
		expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
	}, 65_000)

	it("prints --help without gnuradio", () => {
		const result = python([SCRIPT, "--help"])
		expect(result.status, `${result.stderr}`).toBe(0)
	})
})

describe.skipIf(!hasDecryptModules)("lora_meshtastic_decode.py decrypt", () => {
	const driver = (crcValid: string, frameHex: string): string[] => [
		"-c",
		[
			"import importlib.util, json, sys",
			`spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(SCRIPT)})`,
			"w = importlib.util.module_from_spec(spec); sys.modules['w'] = w; spec.loader.exec_module(w)",
			"w.add_proto_paths(); import mesh_pb2",
			"drops = w.DropCounter(log=lambda *a, **k: None)",
			`frame = w.AssembledFrame(bytes.fromhex(${JSON.stringify(frameHex)}), ${crcValid})`,
			"event = w.process_frame(frame, w.decode_channel_key('AQ=='), mesh_pb2.Data, drops, {'frequency': 869525000, 'bw': 250000, 'sf': 11, 'cr': 5})",
			"print(json.dumps({'event': event, 'drops': dict(drops.total)}))",
		].join("\n"),
	]
	const run = (crcValid: string, frameHex = FRAME.toString("hex")) => {
		const result = python(driver(crcValid, frameHex))
		expect(result.status, `${result.stderr}`).toBe(0)
		return JSON.parse(String(result.stdout)) as {
			event: unknown
			drops: Record<string, number>
		}
	}

	it("emits a packet the adapter schema accepts", () => {
		const { event, drops } = run("True")
		expect(drops).toEqual({})
		const packet = parseMeshtasticPacket(event)
		expect(packet).toMatchObject({
			from: 169_552_957,
			to: 0xffffffff,
			id: 305_419_896,
			channel: 8,
			hopLimit: 3,
			hopStart: 3,
			wantAck: false,
			portnum: 1,
			payloadB64: "aGVsbG8gd2F2ZWtpdA==",
			payloadLen: 13,
			frequency: 869_525_000,
		})
	})

	it("drops a bad-CRC frame and garbage", () => {
		expect(run("False")).toEqual({ event: null, drops: { crc_bad: 1 } })
		expect(run("True", "00".repeat(7))).toEqual({
			event: null,
			drops: { short_frame: 1 },
		})
		const flipped = Buffer.from(FRAME)
		flipped[16] = (flipped[16] ?? 0) ^ 0xff
		expect(run("True", flipped.toString("hex"))).toEqual({
			event: null,
			drops: { data_parse: 1 },
		})
	})
})
