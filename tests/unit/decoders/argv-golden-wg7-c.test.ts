// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
//
// Argv goldens for HW.2: representative in-bounds configurations (the commented
// examples in config/default.yaml and the fixtures of the adapter tests) must keep
// producing byte-identical argv. Expected values were recorded from the frozen code.
import { describe, expect, it } from "vitest"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"

const logger = pino({ level: "silent" })

type Row = {
	config: Record<string, unknown>
	expected: { getDecoderArgs?: unknown; getArgs?: unknown }
}

const GOLDEN: Record<string, Row[]> = {
	acarsdec: [
		{
			config: {
				options: { outputFormat: "json", frequencies: [131550000, 131725000] },
			},
			expected: {
				getDecoderArgs: [
					"--output",
					"json:file:path=-",
					"--sndfile",
					"/dev/stdin,subtype=0x02",
					"-m",
					"1",
				],
				getArgs: [
					"-c",
					"csdr convert -i char -o float | csdr firdecimate 100 0.002500 --cutoff 0.3750 | csdr amdemod | csdr agc -f float -p fast -r 0.8 | csdr dcblock | csdr gain 1 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 24000 -e signed -b 16 -c 1 - -t raw -r 12000 - | acarsdec --output json:file:path=- --sndfile /dev/stdin,subtype=0x02 -m 1",
				],
			},
		},
		{
			config: {
				options: {
					frequencies: [131550000],
					extraArgs: ["-v"],
					inputSampleRate: 2400000,
					gain: 40,
				},
			},
			expected: {
				getDecoderArgs: [
					"--output",
					"json:file:path=-",
					"--sndfile",
					"/dev/stdin,subtype=0x02",
					"-m",
					"1",
					"-v",
				],
				getArgs: [
					"-c",
					"csdr convert -i char -o float | csdr firdecimate 100 0.002500 --cutoff 0.3750 | csdr amdemod | csdr agc -f float -p fast -r 0.8 | csdr dcblock | csdr gain 1 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 24000 -e signed -b 16 -c 1 - -t raw -r 12000 - | acarsdec --output json:file:path=- --sndfile /dev/stdin,subtype=0x02 -m 1 -v",
				],
			},
		},
		{
			config: {
				frequencies: [131550000, 131725000, 131825000],
				deviceSerial: "00000003",
				options: { outputFormat: "json" },
			},
			expected: {
				getDecoderArgs: [
					"--output",
					"json:file:path=-",
					"--sndfile",
					"/dev/stdin,subtype=0x02",
					"-m",
					"1",
				],
				getArgs: [
					"-c",
					"csdr convert -i char -o float | csdr firdecimate 100 0.002500 --cutoff 0.3750 | csdr amdemod | csdr agc -f float -p fast -r 0.8 | csdr dcblock | csdr gain 1 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 24000 -e signed -b 16 -c 1 - -t raw -r 12000 - | acarsdec --output json:file:path=- --sndfile /dev/stdin,subtype=0x02 -m 1",
				],
			},
		},
	],
	dumpvdl2: [
		{
			config: {
				deviceSerial: "00000001",
				frequencies: [136650000, 136700000, 136975000],
				options: { outputFormat: "json" },
			},
			expected: {
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
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 1050000 - rate -h 1050000 | dumpvdl2 --iq-file - --sample-format U8 --oversample 10 --centerfreq 136650000 --output decoded:json:file:path=- 136650000 136700000 136975000",
				],
			},
		},
		{
			config: { options: {} },
			expected: {
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
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 1050000 - rate -h 1050000 | dumpvdl2 --iq-file - --sample-format U8 --oversample 10 --centerfreq 136650000 --output decoded:json:file:path=- 136650000 136700000 136975000",
				],
			},
		},
		{
			config: {
				options: {
					inputCenterFreq: 136800000,
					followCenter: true,
					targetSampleRate: 525000,
					inputSampleRate: 2048000,
				},
			},
			expected: {
				getDecoderArgs: [
					"--iq-file",
					"-",
					"--sample-format",
					"U8",
					"--oversample",
					"5",
					"--centerfreq",
					"136800000",
					"--output",
					"decoded:json:file:path=-",
					"136800000",
				],
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 525000 - rate -h 525000 | dumpvdl2 --iq-file - --sample-format U8 --oversample 5 --centerfreq 136800000 --output decoded:json:file:path=- 136800000",
				],
			},
		},
		{
			config: {
				options: {
					inputCenterFreq: "136800000",
					frequencies: [136975000],
					extraArgs: ["--foo"],
					gain: 40,
					ppm: 2,
				},
			},
			expected: {
				getDecoderArgs: [
					"--iq-file",
					"-",
					"--sample-format",
					"U8",
					"--oversample",
					"10",
					"--centerfreq",
					"136800000",
					"--output",
					"decoded:json:file:path=-",
					"--foo",
					"136975000",
				],
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 1050000 - rate -h 1050000 | dumpvdl2 --iq-file - --sample-format U8 --oversample 10 --centerfreq 136800000 --output decoded:json:file:path=- --foo 136975000",
				],
			},
		},
	],
	"ais-catcher": [
		{
			config: { options: { outputFormat: "nmea" } },
			expected: {
				getDecoderArgs: ["-r", "CU8", ".", "-s", "384000", "-o", "1"],
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - -t raw -e unsigned-integer -b 8 -c 2 -r 384000 - rate -h 384000 | AIS-catcher -r CU8 . -s 384000 -o 1",
				],
			},
		},
		{
			config: { options: { outputFormat: "json" } },
			expected: {
				getDecoderArgs: ["-r", "CU8", ".", "-s", "384000", "-o", "5"],
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - -t raw -e unsigned-integer -b 8 -c 2 -r 384000 - rate -h 384000 | AIS-catcher -r CU8 . -s 384000 -o 5",
				],
			},
		},
		{
			config: {
				options: {
					outputFormat: "nmea",
					gain: 33.8,
					ppm: 3,
					inputSampleRate: 2400000,
				},
			},
			expected: {
				getDecoderArgs: [
					"-r",
					"CU8",
					".",
					"-s",
					"384000",
					"-gr",
					"tuner=33.8",
					"-p",
					"3",
					"-o",
					"1",
				],
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - -t raw -e unsigned-integer -b 8 -c 2 -r 384000 - rate -h 384000 | AIS-catcher -r CU8 . -s 384000 -gr tuner=33.8 -p 3 -o 1",
				],
			},
		},
		{
			config: {
				options: {
					gain: "33.8",
					ppm: "-2",
					extraArgs: ["-q"],
					inputSampleRate: 1200000,
				},
			},
			expected: {
				getDecoderArgs: [
					"-r",
					"CU8",
					".",
					"-s",
					"384000",
					"-gr",
					"tuner=33.8",
					"-p",
					"-2",
					"-o",
					"1",
					"-q",
				],
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 1200000 - -t raw -e unsigned-integer -b 8 -c 2 -r 384000 - rate -h 384000 | AIS-catcher -r CU8 . -s 384000 -gr tuner=33.8 -p -2 -o 1 -q",
				],
			},
		},
	],
	readsb: [
		{
			config: { options: { outputFormat: "sbs" } },
			expected: {
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - rate -h 2400000 | readsb --device-type ifile --ifile - --iformat UC8 --net-sbs-port 30003 --net",
				],
			},
		},
		{
			config: { options: { outputFormat: "beast" } },
			expected: {
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - rate -h 2400000 | readsb --device-type ifile --ifile - --iformat UC8 --net-bo-port 30005 --net",
				],
			},
		},
		{
			config: { options: { outputFormat: "json", outputPort: 30010 } },
			expected: {
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - rate -h 2400000 | readsb --device-type ifile --ifile - --iformat UC8 --net-json-port 30010 --net",
				],
			},
		},
		{
			config: {
				options: {
					outputFormat: "sbs",
					gain: 49.6,
					ppm: 2,
					lat: 37.7749,
					lon: -122.4194,
				},
			},
			expected: {
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - rate -h 2400000 | readsb --device-type ifile --ifile - --iformat UC8 --gain 49.6 --ppm 2 --net-sbs-port 30003 --net --lat 37.7749 --lon -122.4194",
				],
			},
		},
		{
			config: { options: { outputFormat: "sbs", rtlTcpHost: "10.0.0.2" } },
			expected: {
				getArgs: [
					"--device-type",
					"rtltcp",
					"--net-connector",
					"10.0.0.2,1234,beast_in",
					"--net-sbs-port",
					"30003",
					"--net",
				],
			},
		},
		{
			config: {
				options: {
					outputFormat: "sbs",
					rtlTcpHost: "10.0.0.2",
					rtlTcpPort: 1235,
					gain: 49.6,
					ppm: "3",
				},
			},
			expected: {
				getArgs: [
					"--device-type",
					"rtltcp",
					"--net-connector",
					"10.0.0.2,1235,beast_in",
					"--gain",
					"49.6",
					"--ppm",
					"3",
					"--gain",
					"49.6",
					"--ppm",
					"3",
					"--net-sbs-port",
					"30003",
					"--net",
				],
			},
		},
		{
			config: { options: { outputFormat: "sbs", inputSampleRate: 2400000 } },
			expected: {
				getArgs: [
					"-c",
					"readsb --device-type ifile --ifile - --iformat UC8 --net-sbs-port 30003 --net",
				],
			},
		},
		{
			config: {
				options: {
					outputFormat: "sbs",
					inputSampleRate: 2048000,
					extraArgs: ["--quiet"],
				},
			},
			expected: {
				getArgs: [
					"-c",
					"sox -q -D -t raw -e unsigned-integer -b 8 -c 2 -r 2048000 - -t raw -e unsigned-integer -b 8 -c 2 -r 2400000 - rate -h 2400000 | readsb --device-type ifile --ifile - --iformat UC8 --net-sbs-port 30003 --net --quiet",
				],
			},
		},
	],
	direwolf: [
		{
			config: {
				options: { audioDevice: "stdin", sampleRate: 48000, kissPort: 8001 },
			},
			expected: {
				getDecoderArgs: [
					"-c",
					"/etc/direwolf.conf",
					"-",
					"-r",
					"48000",
					"-p",
					"8001",
					"-a",
					"8000",
				],
				getArgs: [
					"-c",
					"csdr convert -i char -o float | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | direwolf -c /etc/direwolf.conf - -r 48000 -p 8001 -a 8000",
				],
			},
		},
		{
			config: { options: { kissPort: 8002, agwPort: 8010 } },
			expected: {
				getDecoderArgs: [
					"-c",
					"/etc/direwolf.conf",
					"-",
					"-r",
					"48000",
					"-p",
					"8002",
					"-a",
					"8010",
				],
				getArgs: [
					"-c",
					"csdr convert -i char -o float | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | direwolf -c /etc/direwolf.conf - -r 48000 -p 8002 -a 8010",
				],
			},
		},
		{
			config: {
				options: {
					agwPort: "8011",
					extraArgs: ["-t", "0"],
					inputSampleRate: 2400000,
				},
			},
			expected: {
				getDecoderArgs: [
					"-c",
					"/etc/direwolf.conf",
					"-",
					"-r",
					"48000",
					"-p",
					"8001",
					"-a",
					"8011",
					"-t",
					"0",
				],
				getArgs: [
					"-c",
					"csdr convert -i char -o float | csdr firdecimate 50 0.012 | csdr fmdemod | csdr gain 3 | csdr limit | csdr convert -i float -o s16 | direwolf -c /etc/direwolf.conf - -r 48000 -p 8001 -a 8011 -t 0",
				],
			},
		},
	],
}

const BUILD: Record<
	string,
	new (config: DecoderConfig, logger: pino.Logger) => unknown
> = {
	acarsdec: AcarsdecDecoder,
	dumpvdl2: Dumpvdl2Decoder,
	"ais-catcher": AisCatcherDecoder,
	readsb: ReadsbDecoder,
	direwolf: DirewolfDecoder,
}

describe("WG7 HW.2 argv goldens (in-bounds configs unchanged)", () => {
	for (const [type, rows] of Object.entries(GOLDEN)) {
		it.each(rows.map((row, index) => ({ row, index })))(
			`${type} case $index`,
			({ row }) => {
				const config = {
					id: "g",
					type,
					enabled: true,
					...row.config,
					options: row.config["options"] ?? {},
				} as unknown as DecoderConfig
				const decoder = new BUILD[type]!(config, logger) as Record<
					string,
					() => unknown
				>
				const actual: Record<string, unknown> = {}
				for (const method of ["getDecoderArgs", "getArgs"]) {
					if (typeof decoder[method] === "function")
						actual[method] = decoder[method]!()
				}
				expect(actual).toEqual(row.expected)
			},
		)
	}
})
