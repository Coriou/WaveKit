#!/usr/bin/env node
/**
 * dsd-fme digital voice regression check, on the real binaries. Run it in the
 * core image:
 *
 *   docker run --rm --network none --entrypoint node -v "$PWD:/w:ro" \
 *     -v "$PWD/output:/out" wavekit:local-core /w/scripts/dsd-fme-voice-ab.mjs \
 *     [--chain "<csdr stages>"] [--decoded-wav /out/decoded.wav] [--input <file>]
 *
 * Input: the discriminator output (csdr fmdemod, before any later stage) of
 * one DMR PTT captured over the air on 2026-10-09 (run 8: TG 9, source
 * 2060945, slot 1, CC 1, dongle tuned 6 kHz below, offsetHz 6000), raw s16le
 * mono at 2048000/43 Hz: tests/mocks/fixtures/dsd-fme/run8-dmr-tx2-fmdemod.s16.
 * The rest of the dsd-fme input chain (BACK_CHAIN below, which must match
 * DsdFmeDecoder.buildPipelineCommand: a unit test checks it) and the sox
 * WAV wrapper are applied here, then dsd-fme runs three times:
 *
 * 1. Voice on vs off: `-o null`, `-o udp:... -V 3` (the digital voice
 *    stream) and `-o udp:...` must decode identically (normalised stderr).
 * 2. Voice quality: the decoded voice must not be chopped. Before the
 *    2026-10-09 fix, `csdr dcblock` in the chain muted ~20 % of the voice
 *    (AMBE errors ~2500 per two PTTs); limits: < 5 % muted, < 300 AMBE errors.
 *
 * --chain        csdr stages between fmdemod and `convert -i float -o s16`
 *                (default BACK_CHAIN), e.g. "csdr dcblock | csdr gain 2 | csdr limit".
 * --decoded-wav  write the voice received over UDP (8 kHz mono WAV).
 * --input        another discriminator capture (same format).
 * Exit code 0 on success, 1 on failure.
 */

import { spawn } from "node:child_process"
import dgram from "node:dgram"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Stages after `csdr fmdemod` in DsdFmeDecoder.buildPipelineCommand. */
export const BACK_CHAIN = "csdr gain 2 | csdr limit"
export const DEMOD_RATE = 2048000 / 43
export const MAX_MUTED_PERCENT = 5
export const MAX_AUDIO_ERRORS = 300

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = name => {
	const i = args.indexOf(name)
	return i >= 0 ? args[i + 1] : undefined
}
const input =
	option("--input") ??
	join(here, "../tests/mocks/fixtures/dsd-fme/run8-dmr-tx2-fmdemod.s16")
const chain = option("--chain") ?? BACK_CHAIN
const decodedWav = option("--decoded-wav")

const BANNER =
	/TDMA Voice Synthesis|UDP Blaster Output|Audio In Device|Total audio errors|sox WARN/

function feedCommand() {
	return [
		`csdr convert -i s16 -o float < '${input}'`,
		chain,
		"csdr convert -i float -o s16",
		`sox -t raw -r ${DEMOD_RATE} -e signed -b 16 -c 1 - -t wav -r 48000 -`,
	].join(" | ")
}

function normalise(text) {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.split("\n")
		.map(line => line.replace(/^\d{2}:\d{2}:\d{2} /, "").trimEnd())
		.filter(line => line && !BANNER.test(line))
		.join("\n")
}

function summarise(raw) {
	const text = raw.replace(/\x1b\[[0-9;]*m/g, "")
	const count = re => text.split("\n").filter(line => re.test(line)).length
	const audio = /Total audio errors: (\d+)/.exec(text)
	return {
		dmrSync: count(/Sync: [+-]DMR/),
		linkControl: count(/\bTGT=\d+ SRC=\d+/),
		terminators: count(/\|\s*TLC\b/),
		fecErr: (text.match(/FEC ERR/g) ?? []).length,
		crcErr: (text.match(/CRC ERR/g) ?? []).length,
		audioErrors: audio ? Number(audio[1]) : null,
	}
}

async function runMode(label, outputArgs) {
	const socket = dgram.createSocket("udp4")
	const datagrams = []
	socket.on("message", msg => datagrams.push(Buffer.from(msg)))
	await new Promise(resolve => socket.bind(0, "127.0.0.1", resolve))
	const port = socket.address().port
	const dsd = `dsd-fme -i /dev/stdin -fa ${outputArgs.replace("PORT", String(port))}`
	const child = spawn("sh", ["-c", `${feedCommand()} | ${dsd}`], {
		stdio: ["ignore", "ignore", "pipe"],
	})
	let stderr = ""
	child.stderr.on("data", chunk => {
		stderr += chunk.toString()
	})
	const code = await new Promise(resolve => child.on("exit", resolve))
	await new Promise(resolve => setTimeout(resolve, 200))
	socket.close()
	return {
		label,
		code,
		decoded: normalise(stderr),
		summary: summarise(stderr),
		datagrams,
	}
}

function wavFile(pcm, rate) {
	const header = Buffer.alloc(44)
	header.write("RIFF", 0, "ascii")
	header.writeUInt32LE(36 + pcm.length, 4)
	header.write("WAVEfmt ", 8, "ascii")
	header.writeUInt32LE(16, 16)
	header.writeUInt16LE(1, 20)
	header.writeUInt16LE(1, 22)
	header.writeUInt32LE(rate, 24)
	header.writeUInt32LE(rate * 2, 28)
	header.writeUInt16LE(2, 32)
	header.writeUInt16LE(16, 34)
	header.write("data", 36, "ascii")
	header.writeUInt32LE(pcm.length, 40)
	return Buffer.concat([header, pcm])
}

/** Stereo 8 kHz datagrams to mono: identical channels once, else the clamped sum. */
function toMono(datagrams) {
	return Buffer.concat(
		datagrams.map(d => {
			const frames = d.length / 4
			const out = Buffer.alloc(frames * 2)
			let identical = true
			for (let i = 0; i < frames && identical; i++) {
				identical = d.readInt16LE(i * 4) === d.readInt16LE(i * 4 + 2)
			}
			for (let i = 0; i < frames; i++) {
				const l = d.readInt16LE(i * 4)
				const r = d.readInt16LE(i * 4 + 2)
				const s = identical ? l : Math.max(-32768, Math.min(32767, l + r))
				out.writeInt16LE(s, i * 2)
			}
			return out
		}),
	)
}

/** Share of exact-zero samples between the first and last sound (muted frames). */
function mutedPercent(pcm) {
	let first = -1
	let last = -1
	for (let i = 0; i < pcm.length; i += 2) {
		if (pcm.readInt16LE(i) !== 0) {
			if (first < 0) first = i
			last = i
		}
	}
	if (first < 0) return 100
	let zero = 0
	for (let i = first; i <= last; i += 2) if (pcm.readInt16LE(i) === 0) zero++
	return (100 * zero) / ((last - first) / 2 + 1)
}

readFileSync(input) // fail early on a missing input
const modes = [
	await runMode("null", "-o null"),
	await runMode("udp -V 3", "-o udp:127.0.0.1:PORT -V 3"),
	await runMode("udp", "-o udp:127.0.0.1:PORT"),
]
const voice = toMono(modes[1].datagrams)
const muted = mutedPercent(voice)

let ok = true
const fail = message => {
	ok = false
	process.stdout.write(`  FAIL: ${message}\n`)
}
process.stdout.write(`chain after fmdemod: ${chain}\n`)
for (const mode of modes) {
	process.stdout.write(
		`${mode.label.padEnd(9)} exit=${mode.code} ${JSON.stringify(mode.summary)} voice=${(mode.datagrams.length * 0.02).toFixed(2)}s\n`,
	)
	if (mode.decoded !== modes[0].decoded)
		fail(`${mode.label} decode differs from -o null`)
	if (mode.label !== "null" && mode.datagrams.length === 0) {
		fail(`${mode.label} delivered no voice`)
	}
}
const quality = modes[0].summary
process.stdout.write(
	`voice quality: muted ${muted.toFixed(1)} % (limit ${MAX_MUTED_PERCENT}), AMBE errors ${quality.audioErrors} (limit ${MAX_AUDIO_ERRORS})\n`,
)
if (quality.terminators === 0) fail("no DMR call terminator decoded")
if (muted >= MAX_MUTED_PERCENT) fail("decoded voice is chopped (muted frames)")
if (quality.audioErrors === null || quality.audioErrors >= MAX_AUDIO_ERRORS) {
	fail("too many AMBE frame errors")
}
if (decodedWav) {
	writeFileSync(decodedWav, wavFile(voice, 8000))
	process.stdout.write(`decoded voice written to ${decodedWav}\n`)
}
process.stdout.write(ok ? "PASS\n" : "FAIL\n")
process.exit(ok ? 0 : 1)
