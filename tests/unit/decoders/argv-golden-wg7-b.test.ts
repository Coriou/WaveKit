// The frozen argv fixtures include the intentional streaming-length correction:
// SoX must ignore stdin's queued socket size and read until EOF (--ignore-length).
// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.5
//
// Argv goldens for HW.2 (lane B: multimon-ng, rtl433, dsd-fme and the audio-demod /
// IQ-decimate bases every other adapter builds on). Every decoder in config/*.yaml, the
// commented examples in config/default.yaml and the adapter test fixtures must keep
// producing byte-identical argv and pipeline strings. Expected values were recorded
// from the frozen code (cccf665f) and are inlined here as literals.
import { describe, expect, it } from "vitest"
import path from "node:path"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { Rtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import {
	DirewolfDecoder,
	direwolfConfigPath,
} from "../../../src/decoders/builtin/direwolf.js"
import { shellCommand } from "../../../src/decoders/process-tools.js"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { LoraMeshtasticDecoder } from "../../../src/decoders/builtin/lora-meshtastic.js"

/** Every golden builds its decoder with id "g": the per-instance direwolf config path. */
const DW_CONF = direwolfConfigPath("g")
const DW_CONF_SH = shellCommand(DW_CONF, [])

const logger = pino({ level: "silent" })

/** dsd-fme resolves a relative wavDir against the working directory. */
const CWD_CALLS = path.resolve("./decoded_calls")

const BUILD: Record<
	string,
	new (config: DecoderConfig, logger: pino.Logger) => unknown
> = {
	"multimon-ng": MultimonDecoder,
	rtl433: Rtl433Decoder,
	"dsd-fme": DsdFmeDecoder,
	direwolf: DirewolfDecoder,
	acarsdec: AcarsdecDecoder,
	dumpvdl2: Dumpvdl2Decoder,
	"ais-catcher": AisCatcherDecoder,
	"lora-meshtastic": LoraMeshtasticDecoder,
}

interface Row {
	type: string
	source: string
	options: Record<string, unknown>
	getArgs: string[]
	getDecoderArgs: string[]
}

const GOLDEN: Row[] = [
	{
		type: "multimon-ng",
		source: "config/dev_test.yaml#pagers",
		options: {
			modes: ["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"],
			inputSampleRate: 2048000,
			fmGain: 3,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 43 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 47627.90697674418 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -a FLEX -",
		],
		getDecoderArgs: [
			"-t",
			"raw",
			"-a",
			"POCSAG512",
			"-a",
			"POCSAG1200",
			"-a",
			"POCSAG2400",
			"-a",
			"FLEX",
			"-",
		],
	},
	{
		type: "dsd-fme",
		source: "config/dev_test.yaml#digital-voice",
		options: {
			mode: "auto",
			output: null,
			inputSampleRate: 2048000,
			fmGain: 2,
			enablePerCallRecording: true,
			perCallRecordingDir: "/app/decoded_calls",
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 43 0.003052 --cutoff 0.1968 | csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 47627.90697674418 -e signed -b 16 -c 1 - -t wav -r 48000 - | (mkdir -p /app/decoded_calls && cd /app/decoded_calls && dsd-fme -i /dev/stdin -7 /app/decoded_calls -P -fa -o null)",
		],
		getDecoderArgs: [
			"-i",
			"/dev/stdin",
			"-7",
			"/app/decoded_calls",
			"-P",
			"-fa",
			"-o",
			"null",
		],
	},
	{
		type: "direwolf",
		source: "config/dev_test.yaml#aprs",
		options: {
			audioDevice: "stdin",
			sampleRate: 48000,
			inputSampleRate: 2048000,
			kissPort: 8001,
			callsign: "N0CALL",
		},
		getArgs: [
			"-c",
			`csdr convert -i char -o float | csdr firdecimate 43 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 47627.90697674418 -e signed -b 16 -c 1 - -t raw -r 48000 - | direwolf -c ${DW_CONF_SH} - -r 48000`,
		],
		getDecoderArgs: ["-c", DW_CONF, "-", "-r", "48000"],
	},
	{
		type: "rtl433",
		source: "config/dev_test.yaml#rtl433",
		options: {
			outputFormat: "json",
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 2 0.05 | csdr convert -i float -o char | rtl_433 -r cu8:- -s 1024000 -F json -Y autolevel -M level",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
		],
	},
	{
		type: "ais-catcher",
		source: "config/dev_test.yaml#ais",
		options: {
			outputFormat: "json",
			inputSampleRate: 2048000,
		},
		getArgs: [
			"-c",
			"sox -q -D --ignore-length -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 384000 - rate -h 384000 | AIS-catcher -r CU8 . -s 384000 -o 5",
		],
		getDecoderArgs: ["-r", "CU8", ".", "-s", "384000", "-o", "5"],
	},
	{
		type: "acarsdec",
		source: "config/dev_test.yaml#acars",
		options: {
			inputSampleRate: 2048000,
			frequencies: [131550000, 131725000],
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 85 0.002941 --cutoff 0.3750 | csdr amdemod | csdr agc -f float -p fast -r 0.8 | csdr dcblock | csdr gain 1 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 24094.117647058825 -e signed -b 16 -c 1 - -t raw -r 12000 - | acarsdec --output json:file:path=- --sndfile /dev/stdin,subtype=0x02 -m 1",
		],
		getDecoderArgs: [
			"--output",
			"json:file:path=-",
			"--sndfile",
			"/dev/stdin,subtype=0x02",
			"-m",
			"1",
		],
	},
	{
		type: "dumpvdl2",
		source: "config/dev_test.yaml#vdl2",
		options: {
			frequencies: [136650000, 136975000],
			outputFormat: "json",
		},
		getArgs: [
			"-c",
			"sox -q -D --ignore-length -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 1050000 - rate -h 1050000 | dumpvdl2 --iq-file - --sample-format U8 --oversample 10 --centerfreq 136650000 --output decoded:json:file:path=- 136650000 136975000",
		],
		getDecoderArgs: [
			"--iq-file",
			"-",
			"--sample-format",
			"U8",
			"--oversample",
			"10",
			"--centerfreq",
			"136650000",
			"--output",
			"decoded:json:file:path=-",
			"136650000",
			"136975000",
		],
	},
	{
		type: "multimon-ng",
		source: "fixture",
		options: {},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -",
		],
		getDecoderArgs: [
			"-t",
			"raw",
			"-a",
			"POCSAG512",
			"-a",
			"POCSAG1200",
			"-a",
			"POCSAG2400",
			"-",
		],
	},
	{
		type: "multimon-ng",
		source: "fixture",
		options: {
			modes: ["POCSAG1200"],
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a POCSAG1200 -",
		],
		getDecoderArgs: ["-t", "raw", "-a", "POCSAG1200", "-"],
	},
	{
		type: "multimon-ng",
		source: "fixture",
		options: {
			modes: ["POCSAG512", "FLEX"],
			verbosity: 2,
			charset: "DE",
			filters: {
				highpass: 300,
				lowpass: 3000,
				gain: 2,
			},
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a POCSAG512 -a FLEX -v -v -c DE --highpass 300 --lowpass 3000 --gain 2 -",
		],
		getDecoderArgs: [
			"-t",
			"raw",
			"-a",
			"POCSAG512",
			"-a",
			"FLEX",
			"-v",
			"-v",
			"-c",
			"DE",
			"--highpass",
			"300",
			"--lowpass",
			"3000",
			"--gain",
			"2",
			"-",
		],
	},
	{
		type: "multimon-ng",
		source: "fixture",
		options: {
			modes: ["FLEX"],
			verbosity: "3",
			filters: {
				highpass: "300",
				gain: "-1.5",
			},
			fmGain: 4.5,
			inputSampleRate: 2048000,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 43 0.012 | csdr fmdemod | csdr gain 4.5 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 47627.90697674418 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a FLEX -v -v -v --highpass 300 --gain -1.5 -",
		],
		getDecoderArgs: [
			"-t",
			"raw",
			"-a",
			"FLEX",
			"-v",
			"-v",
			"-v",
			"--highpass",
			"300",
			"--gain",
			"-1.5",
			"-",
		],
	},
	{
		type: "multimon-ng",
		source: "fixture",
		options: {
			verbosity: 0,
			fmGain: 0,
			inputSampleRate: 0,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 0 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -",
		],
		getDecoderArgs: [
			"-t",
			"raw",
			"-a",
			"POCSAG512",
			"-a",
			"POCSAG1200",
			"-a",
			"POCSAG2400",
			"-",
		],
	},
	{
		type: "multimon-ng",
		source: "fixture",
		options: {
			offsetHz: 25000,
			inputSampleRate: 2400000,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr shift -0.0104166667 | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -",
		],
		getDecoderArgs: [
			"-t",
			"raw",
			"-a",
			"POCSAG512",
			"-a",
			"POCSAG1200",
			"-a",
			"POCSAG2400",
			"-",
		],
	},
	{
		type: "multimon-ng",
		source: "fixture",
		options: {
			inputIqFormat: "cf32",
			inputSampleRate: 48000,
		},
		getArgs: [
			"-c",
			"csdr agc -f complex -p slow -r 0.7 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -",
		],
		getDecoderArgs: [
			"-t",
			"raw",
			"-a",
			"POCSAG512",
			"-a",
			"POCSAG1200",
			"-a",
			"POCSAG2400",
			"-",
		],
	},
	{
		type: "rtl433",
		source: "fixture",
		options: {
			outputFormat: "json",
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 2 0.05 | csdr convert -i float -o char | rtl_433 -r cu8:- -s 1024000 -F json -Y autolevel -M level",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
		],
	},
	{
		type: "rtl433",
		source: "fixture",
		options: {
			outputFormat: "json",
			inputSampleRate: 2048000,
			targetSampleRate: 1000000,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 2 0.05 | csdr convert -i float -o char | rtl_433 -r cu8:- -s 1024000 -F json -Y autolevel -M level",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
		],
	},
	{
		type: "rtl433",
		source: "fixture",
		options: {
			outputFormat: "json",
			extraArgs: ["-f", "433920000"],
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 2 0.05 | csdr convert -i float -o char | rtl_433 -r cu8:- -s 1024000 -F json -Y autolevel -M level -f 433920000",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
			"-f",
			"433920000",
		],
	},
	{
		type: "rtl433",
		source: "fixture",
		options: {
			outputFormat: "csv",
			analyze: true,
			protocols: [1, "40", 113],
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 2 0.05 | csdr convert -i float -o char | rtl_433 -r cu8:- -s 1024000 -F csv -Y autolevel -M level -A -G 0 -R 1 -R 40 -R 113",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"csv",
			"-Y",
			"autolevel",
			"-M",
			"level",
			"-A",
			"-G",
			"0",
			"-R",
			"1",
			"-R",
			"40",
			"-R",
			"113",
		],
	},
	{
		type: "rtl433",
		source: "fixture",
		options: {
			inputSampleRate: 1000000,
			targetSampleRate: 1000000,
		},
		getArgs: [
			"-c",
			"rtl_433 -r cu8:- -s 1000000 -F json -Y autolevel -M level",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"1000000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
		],
	},
	{
		type: "rtl433",
		source: "fixture",
		options: {
			inputSampleRate: 2400000,
			targetSampleRate: 250000,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 10 0.05 | csdr convert -i float -o char | rtl_433 -r cu8:- -s 240000 -F json -Y autolevel -M level",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"240000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
		],
	},
	{
		type: "dsd-fme",
		source: "fixture",
		options: {
			mode: "auto",
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 50 0.002604 --cutoff 0.1953 | csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme -i /dev/stdin -fa -o null",
		],
		getDecoderArgs: ["-i", "/dev/stdin", "-fa", "-o", "null"],
	},
	{
		type: "dsd-fme",
		source: "fixture",
		options: {
			mode: "dmr",
			output: "udp",
			udpHost: "127.0.0.1",
			udpPort: 23456,
			voiceSlot: 2,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 50 0.002604 --cutoff 0.1953 | csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme -i /dev/stdin -fs -o udp:127.0.0.1:23456 -V 2",
		],
		getDecoderArgs: [
			"-i",
			"/dev/stdin",
			"-fs",
			"-o",
			"udp:127.0.0.1:23456",
			"-V",
			"2",
		],
	},
	{
		type: "dsd-fme",
		source: "fixture",
		options: {
			mode: "p25",
			output: "udp",
			udpHost: "127.0.0.1",
			udpPort: "7355",
			voiceSlot: "both",
			fmGain: 3.5,
			inputSampleRate: 2048000,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 43 0.003052 --cutoff 0.1968 | csdr fmdemod | csdr gain 3.5 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 47627.90697674418 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme -i /dev/stdin -f1 -o udp:127.0.0.1:7355 -V 3",
		],
		getDecoderArgs: [
			"-i",
			"/dev/stdin",
			"-f1",
			"-o",
			"udp:127.0.0.1:7355",
			"-V",
			"3",
		],
	},
	{
		type: "dsd-fme",
		source: "fixture",
		options: {
			mode: "ysf",
			enablePerCallRecording: true,
			perCallRecordingDir: "/app/decoded_calls",
			callTimeoutMs: 1500,
			minCallDurationMs: 300,
			callStartDelayMs: 50,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 50 0.002604 --cutoff 0.1953 | csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 - | (mkdir -p /app/decoded_calls && cd /app/decoded_calls && dsd-fme -i /dev/stdin -7 /app/decoded_calls -P -fy -o null)",
		],
		getDecoderArgs: [
			"-i",
			"/dev/stdin",
			"-7",
			"/app/decoded_calls",
			"-P",
			"-fy",
			"-o",
			"null",
		],
	},
	{
		type: "dsd-fme",
		source: "fixture",
		options: {
			mode: "nxdn",
			offsetHz: 6000,
			inputSampleRate: 2048000,
			enableIqAgc: false,
			extraArgs: ["-g", "0"],
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr shift -0.0029296875 | csdr firdecimate 43 0.003052 --cutoff 0.1968 | csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 47627.90697674418 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme -i /dev/stdin -fn -o null -g 0",
		],
		getDecoderArgs: ["-i", "/dev/stdin", "-fn", "-o", "null", "-g", "0"],
	},
	{
		type: "dsd-fme",
		source: "fixture",
		options: {
			inputIqFormat: "cf32",
		},
		getArgs: [
			"-c",
			"csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme -i /dev/stdin -fa -o null",
		],
		getDecoderArgs: ["-i", "/dev/stdin", "-fa", "-o", "null"],
	},
	{
		type: "dsd-fme",
		source: "fixture",
		options: {
			mode: "auto",
			voiceSlot: "both",
			enablePerCallRecording: false,
			perCallRecordingDir: "/app/decoded_calls",
			perCallRecordingMaxTotalMb: 512,
			perCallRecordingMaxAgeHours: 168,
			offsetHz: 0,
			callTimeoutMs: 4000,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 50 0.002604 --cutoff 0.1953 | csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme -i /dev/stdin -fa -o null -V 3",
		],
		getDecoderArgs: ["-i", "/dev/stdin", "-fa", "-o", "null", "-V", "3"],
	},
	{
		type: "dsd-fme",
		source: "fixture",
		options: {
			mode: "auto",
			output: "wav",
			wavDir: "./decoded_calls",
		},
		getArgs: [
			"-c",
			`csdr convert -i char -o float | csdr firdecimate 50 0.002604 --cutoff 0.1953 | csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 - | (mkdir -p ${CWD_CALLS} && cd ${CWD_CALLS} && dsd-fme -i /dev/stdin -7 ${CWD_CALLS} -P -fa -o null)`,
		],
		getDecoderArgs: [
			"-i",
			"/dev/stdin",
			"-7",
			CWD_CALLS,
			"-P",
			"-fa",
			"-o",
			"null",
		],
	},
	{
		type: "multimon-ng",
		source: "fixture",
		options: {
			modes: ["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"],
			verbosity: 1,
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 22050 - | multimon-ng -t raw -a POCSAG512 -a POCSAG1200 -a POCSAG2400 -a FLEX -v -",
		],
		getDecoderArgs: [
			"-t",
			"raw",
			"-a",
			"POCSAG512",
			"-a",
			"POCSAG1200",
			"-a",
			"POCSAG2400",
			"-a",
			"FLEX",
			"-v",
			"-",
		],
	},
	{
		type: "rtl433",
		source: "fixture",
		options: {
			analyze: false,
			outputFormat: "json",
			protocols: [],
		},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 2 0.05 | csdr convert -i float -o char | rtl_433 -r cu8:- -s 1024000 -F json -Y autolevel -M level",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
		],
	},
	{
		type: "rtl433",
		source: "fixture",
		options: {},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 2 0.05 | csdr convert -i float -o char | rtl_433 -r cu8:- -s 1024000 -F json -Y autolevel -M level",
		],
		getDecoderArgs: [
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
		],
	},
	{
		type: "direwolf",
		source: "fixture",
		options: {},
		getArgs: [
			"-c",
			`csdr convert -i char -o float | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | direwolf -c ${DW_CONF_SH} - -r 48000`,
		],
		getDecoderArgs: ["-c", DW_CONF, "-", "-r", "48000"],
	},
	{
		type: "direwolf",
		source: "fixture",
		options: {
			inputSampleRate: 2400000,
			offsetHz: 10000,
		},
		getArgs: [
			"-c",
			`csdr convert -i char -o float | csdr shift -0.0041666667 | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | direwolf -c ${DW_CONF_SH} - -r 48000`,
		],
		getDecoderArgs: ["-c", DW_CONF, "-", "-r", "48000"],
	},
	{
		type: "ais-catcher",
		source: "fixture",
		options: {},
		getArgs: [
			"-c",
			"sox -q -D --ignore-length -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - -t raw -e unsigned-integer -b 8 -c 2 -r 384000 - rate -h 384000 | AIS-catcher -r CU8 . -s 384000 -o 1",
		],
		getDecoderArgs: ["-r", "CU8", ".", "-s", "384000", "-o", "1"],
	},
	{
		type: "acarsdec",
		source: "fixture",
		options: {},
		getArgs: [
			"-c",
			"csdr convert -i char -o float | csdr firdecimate 100 0.002500 --cutoff 0.3750 | csdr amdemod | csdr agc -f float -p fast -r 0.8 | csdr dcblock | csdr gain 1 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 24000 -e signed -b 16 -c 1 - -t raw -r 12000 - | acarsdec --output json:file:path=- --sndfile /dev/stdin,subtype=0x02 -m 1",
		],
		getDecoderArgs: [
			"--output",
			"json:file:path=-",
			"--sndfile",
			"/dev/stdin,subtype=0x02",
			"-m",
			"1",
		],
	},
	{
		type: "dumpvdl2",
		source: "fixture",
		options: {},
		getArgs: [
			"-c",
			"sox -q -D --ignore-length -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 1050000 - rate -h 1050000 | dumpvdl2 --iq-file - --sample-format U8 --oversample 10 --centerfreq 136650000 --output decoded:json:file:path=- 136650000 136700000 136975000",
		],
		getDecoderArgs: [
			"--iq-file",
			"-",
			"--sample-format",
			"U8",
			"--oversample",
			"10",
			"--centerfreq",
			"136650000",
			"--output",
			"decoded:json:file:path=-",
			"136650000",
			"136700000",
			"136975000",
		],
	},
	{
		type: "lora-meshtastic",
		source: "fixture",
		options: {
			region: "EU_868",
			preset: "LongFast",
			frequency: 869525000,
			channelKey: "AQ==",
		},
		getArgs: [
			"-c",
			"sox -q -D --ignore-length -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 500000 - rate -m -b 74 500000 | python3 /usr/local/bin/lora_meshtastic_decode.py --bw 250000 --sf 11 --cr 5 --samp-rate 500000 --frequency 869525000 --channel-key AQ== --region EU_868 --cfo-search-hz 50000",
		],
		getDecoderArgs: [
			"/usr/local/bin/lora_meshtastic_decode.py",
			"--bw",
			"250000",
			"--sf",
			"11",
			"--cr",
			"5",
			"--samp-rate",
			"500000",
			"--frequency",
			"869525000",
			"--channel-key",
			"AQ==",
			"--region",
			"EU_868",
			"--cfo-search-hz",
			"50000",
		],
	},
]

describe("WG7 HW.2 argv goldens, lane B (in-bounds configs unchanged)", () => {
	it.each(GOLDEN.map((row, index) => ({ ...row, index })))(
		"$type $source #$index",
		row => {
			const config = {
				id: "g",
				type: row.type,
				enabled: true,
				options: row.options,
			} as unknown as DecoderConfig
			const decoder = new BUILD[row.type]!(config, logger) as Record<
				string,
				() => unknown
			>
			expect(decoder["getArgs"]!()).toEqual(row.getArgs)
			expect(decoder["getDecoderArgs"]!()).toEqual(row.getDecoderArgs)
		},
	)
})
