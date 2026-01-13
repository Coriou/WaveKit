/**
 * Tuner Panel - Interactive RTL-TCP tuner control
 */

import React, { useEffect, useMemo, useState } from "react"
import { Box, Text, useInput } from "ink"
import type {
	TunerState,
	TunerGainMode,
	TunerDirectSampling,
	TunerControlMode,
} from "../types.js"
import { formatLocalTime, formatNumber } from "../utils/format.js"

export type TunerCommand =
	| { type: "setFrequency"; sourceId: string; hz: number }
	| { type: "setSampleRate"; sourceId: string; hz: number }
	| { type: "setGainMode"; sourceId: string; mode: TunerGainMode }
	| { type: "setGain"; sourceId: string; tenthsDb: number }
	| { type: "setPpm"; sourceId: string; ppm: number }
	| { type: "setAgcMode"; sourceId: string; enabled: boolean }
	| { type: "setBiasTee"; sourceId: string; enabled: boolean }
	| { type: "setDirectSampling"; sourceId: string; mode: TunerDirectSampling }
	| { type: "setOffsetTuning"; sourceId: string; enabled: boolean }
	| { type: "setControlMode"; sourceId: string; mode: TunerControlMode }

interface TunerPanelProps {
	states: TunerState[]
	onCommand: (command: TunerCommand) => void | Promise<void>
	actionError?: string | null
	onInputCaptureChange?: (active: boolean) => void
}

const FREQUENCY_RANGE = { min: 24_000_000, max: 1_900_000_000 }
const GAIN_RANGE = { min: 0, max: 500 }
const PPM_RANGE = { min: -500, max: 500 }
const FREQUENCY_STEPS = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000]

type NumericInputOptions = {
	allowSigned: boolean
	allowSuffix: boolean
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

function isAllowedInputFragment(
	fragment: string,
	options: NumericInputOptions,
): boolean {
	for (const char of fragment) {
		if (char >= "0" && char <= "9") continue
		if (char === "." || char === ",") continue
		if (options.allowSigned && (char === "-" || char === "+")) {
			continue
		}
		if (
			options.allowSuffix &&
			(char === "k" || char === "K" || char === "m" || char === "M")
		) {
			continue
		}
		return false
	}
	return fragment.length > 0
}

function parseNumericInput(
	value: string,
	options: NumericInputOptions,
): number | null {
	const trimmed = value.trim()
	if (!trimmed) return null

	const suffixMatch = options.allowSuffix ? trimmed.match(/[kKmM]$/) : null
	const suffix = suffixMatch ? suffixMatch[0].toLowerCase() : ""
	const numberPart = suffix ? trimmed.slice(0, -1) : trimmed
	const normalized = numberPart.replace(",", ".")

	if (!options.allowSigned && normalized.startsWith("-")) {
		return null
	}
	if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) {
		return null
	}

	const numeric = Number.parseFloat(normalized)
	if (!Number.isFinite(numeric)) return null

	const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1
	return Math.round(numeric * multiplier)
}

function formatStep(step: number): string {
	if (step >= 1_000_000) return `${step / 1_000_000} MHz`
	if (step >= 1_000) return `${step / 1_000} kHz`
	return `${step} Hz`
}

function nextDirectSampling(mode: TunerDirectSampling): TunerDirectSampling {
	switch (mode) {
		case "off":
			return "i"
		case "i":
			return "q"
		case "q":
			return "off"
	}
}

export function TunerPanel({
	states,
	onCommand,
	actionError = null,
	onInputCaptureChange,
}: TunerPanelProps) {
	const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
		states[0]?.sourceId ?? null,
	)
	const [stepIndex, setStepIndex] = useState<number>(() => {
		const idx = FREQUENCY_STEPS.indexOf(100_000)
		return idx >= 0 ? idx : 0
	})
	const [ppmEdit, setPpmEdit] = useState<string | null>(null)
	const [sampleRateEdit, setSampleRateEdit] = useState<string | null>(null)

	useEffect(() => {
		onInputCaptureChange?.(ppmEdit !== null || sampleRateEdit !== null)
	}, [ppmEdit, sampleRateEdit, onInputCaptureChange])

	useEffect(() => {
		if (!selectedSourceId) {
			setSelectedSourceId(states[0]?.sourceId ?? null)
			return
		}
		if (!states.find(state => state.sourceId === selectedSourceId)) {
			setSelectedSourceId(states[0]?.sourceId ?? null)
		}
	}, [selectedSourceId, states])

	const selectedState = useMemo(() => {
		return states.find(state => state.sourceId === selectedSourceId) ?? null
	}, [states, selectedSourceId])

	useInput((input, key) => {
		if (!selectedState) return

		if (ppmEdit !== null) {
			if (key.escape) {
				setPpmEdit(null)
				return
			}
			if (key.return) {
				const parsed = parseNumericInput(ppmEdit, {
					allowSigned: true,
					allowSuffix: false,
				})
				if (parsed !== null) {
					void onCommand({
						type: "setPpm",
						sourceId: selectedState.sourceId,
						ppm: parsed,
					})
				}
				setPpmEdit(null)
				return
			}
			if (key.backspace || key.delete) {
				setPpmEdit(prev => (prev ? prev.slice(0, -1) : prev))
				return
			}
			if (
				isAllowedInputFragment(input, {
					allowSigned: true,
					allowSuffix: false,
				})
			) {
				setPpmEdit(prev => (prev ?? "") + input)
			}
			return
		}

		if (sampleRateEdit !== null) {
			if (key.escape) {
				setSampleRateEdit(null)
				return
			}
			if (key.return) {
				const parsed = parseNumericInput(sampleRateEdit, {
					allowSigned: false,
					allowSuffix: true,
				})
				if (parsed !== null) {
					void onCommand({
						type: "setSampleRate",
						sourceId: selectedState.sourceId,
						hz: parsed,
					})
				}
				setSampleRateEdit(null)
				return
			}
			if (key.backspace || key.delete) {
				setSampleRateEdit(prev => (prev ? prev.slice(0, -1) : prev))
				return
			}
			if (
				isAllowedInputFragment(input, {
					allowSigned: false,
					allowSuffix: true,
				})
			) {
				setSampleRateEdit(prev => (prev ?? "") + input)
			}
			return
		}

		if (key.tab) {
			if (states.length > 1) {
				const currentIndex = states.findIndex(
					state => state.sourceId === selectedState.sourceId,
				)
				const nextIndex = (currentIndex + 1) % states.length
				const nextState = states[nextIndex]
				setSelectedSourceId(nextState?.sourceId ?? null)
			}
			return
		}

		const canControl = selectedState.controlMode === "internal"

		const stepDown =
			input === "[" || input === "," || input === "<" || key.leftArrow
		const stepUp =
			input === "]" ||
			input === "." ||
			input === ">" ||
			input === "/" ||
			key.rightArrow

		if (stepDown) {
			setStepIndex(prev => Math.max(0, prev - 1))
			return
		}
		if (stepUp) {
			setStepIndex(prev => Math.min(FREQUENCY_STEPS.length - 1, prev + 1))
			return
		}

		if (key.upArrow || key.downArrow) {
			if (!canControl) return
			const step = FREQUENCY_STEPS[stepIndex] ?? 100_000
			const delta = key.upArrow ? step : -step
			const nextFrequency = clamp(
				selectedState.frequency + delta,
				FREQUENCY_RANGE.min,
				FREQUENCY_RANGE.max,
			)
			if (nextFrequency !== selectedState.frequency) {
				void onCommand({
					type: "setFrequency",
					sourceId: selectedState.sourceId,
					hz: nextFrequency,
				})
			}
			return
		}

		if (input === "+" || input === "=") {
			if (!canControl || selectedState.gainMode !== "manual") return
			const nextGain = clamp(
				selectedState.gain + 10,
				GAIN_RANGE.min,
				GAIN_RANGE.max,
			)
			if (nextGain !== selectedState.gain) {
				void onCommand({
					type: "setGain",
					sourceId: selectedState.sourceId,
					tenthsDb: nextGain,
				})
			}
			return
		}

		if (input === "-") {
			if (!canControl || selectedState.gainMode !== "manual") return
			const nextGain = clamp(
				selectedState.gain - 10,
				GAIN_RANGE.min,
				GAIN_RANGE.max,
			)
			if (nextGain !== selectedState.gain) {
				void onCommand({
					type: "setGain",
					sourceId: selectedState.sourceId,
					tenthsDb: nextGain,
				})
			}
			return
		}

		switch (input) {
			case "g": {
				if (!canControl) return
				const nextMode: TunerGainMode =
					selectedState.gainMode === "manual" ? "agc" : "manual"
				void onCommand({
					type: "setGainMode",
					sourceId: selectedState.sourceId,
					mode: nextMode,
				})
				return
			}
			case "a": {
				if (!canControl) return
				void onCommand({
					type: "setAgcMode",
					sourceId: selectedState.sourceId,
					enabled: !selectedState.agcMode,
				})
				return
			}
			case "b": {
				if (!canControl) return
				void onCommand({
					type: "setBiasTee",
					sourceId: selectedState.sourceId,
					enabled: !selectedState.biasTee,
				})
				return
			}
			case "d": {
				if (!canControl) return
				void onCommand({
					type: "setDirectSampling",
					sourceId: selectedState.sourceId,
					mode: nextDirectSampling(selectedState.directSampling),
				})
				return
			}
			case "o": {
				if (!canControl) return
				void onCommand({
					type: "setOffsetTuning",
					sourceId: selectedState.sourceId,
					enabled: !selectedState.offsetTuning,
				})
				return
			}
			case "c": {
				const nextMode: TunerControlMode =
					selectedState.controlMode === "internal" ? "external" : "internal"
				void onCommand({
					type: "setControlMode",
					sourceId: selectedState.sourceId,
					mode: nextMode,
				})
				return
			}
			case "p": {
				if (!canControl) return
				setPpmEdit(selectedState.ppm.toString())
				return
			}
			case "s": {
				if (!canControl) return
				setSampleRateEdit(selectedState.sampleRate.toString())
				return
			}
		}
	})

	if (!selectedState) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Text bold color="cyan">
					TUNER
				</Text>
				<Text dimColor>No RTL-TCP tuner sources detected</Text>
			</Box>
		)
	}

	const controlLabel =
		selectedState.controlMode === "internal" ? "INTERNAL" : "EXTERNAL"
	const controlColor =
		selectedState.controlMode === "internal"
			? ("green" as const)
			: ("yellow" as const)
	const sourceHint = states.length > 1 ? " (tab to switch)" : ""
	const gainValue = `${(selectedState.gain / 10).toFixed(1)} dB`
	const showIfGain =
		selectedState.ifGain !== 0 || selectedState.controlMode === "external"
	const showTunerGainIndex = selectedState.tunerGainIndex !== undefined
	const showTunerIfGain = selectedState.tunerIfGain !== null
	const stepValue = formatStep(FREQUENCY_STEPS[stepIndex] ?? 100_000)
	const lastCommand = formatLocalTime(selectedState.lastCommandAt)
	const controlHint =
		selectedState.controlMode === "internal"
			? "Release control to SDR++"
			: "Reclaim control from SDR++"
	const commandHint =
		selectedState.controlMode === "internal" ? "" : " (locked)"

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold color="cyan">
				TUNER
			</Text>

			<Box marginTop={1}>
				<Text>
					Source: {selectedState.sourceId}
					{sourceHint} | Control:{" "}
					<Text color={controlColor}>{controlLabel}</Text>
				</Text>
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text bold color="cyan">
					FREQUENCY
				</Text>
				<Text>{formatNumber(selectedState.frequency)} Hz</Text>
				<Text>
					Sample rate: {formatNumber(selectedState.sampleRate)} Hz [s] edit
				</Text>
				{sampleRateEdit !== null ? (
					<Text dimColor>
						Editing sample rate: {sampleRateEdit || "-"} (enter to apply, esc to
						cancel, k/m allowed)
					</Text>
				) : null}
				<Text dimColor>
					Step: {stepValue} up/down tune left/right change step
				</Text>
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text bold color="cyan">
					GAIN
				</Text>
				<Text>Mode: {selectedState.gainMode.toUpperCase()} [g] toggle</Text>
				<Text dimColor>Level: {gainValue} +/- adjust (manual only)</Text>
				{showTunerGainIndex ? (
					<Text dimColor>Tuner gain index: {selectedState.tunerGainIndex}</Text>
				) : null}
				{showIfGain ? (
					<Text dimColor>IF gain: {selectedState.ifGain}</Text>
				) : null}
				{showTunerIfGain ? (
					<Text dimColor>
						Tuner IF gain: {selectedState.tunerIfGain?.stage}/
						{selectedState.tunerIfGain?.gain}
					</Text>
				) : null}
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text bold color="cyan">
					CORRECTIONS
				</Text>
				<Text>PPM: {selectedState.ppm} [p] edit</Text>
				<Text>RTL AGC: {selectedState.agcMode ? "on" : "off"} [a] toggle</Text>
				{ppmEdit !== null ? (
					<Text dimColor>
						Editing PPM: {ppmEdit || "-"} (enter to apply, esc to cancel)
					</Text>
				) : null}
			</Box>

			<Box marginTop={1} flexDirection="column">
				<Text bold color="cyan">
					ADVANCED
				</Text>
				<Text>Bias-T: {selectedState.biasTee ? "on" : "off"} [b] toggle</Text>
				<Text>
					Direct: {selectedState.directSampling.toUpperCase()} [d] cycle
				</Text>
				<Text>
					Offset: {selectedState.offsetTuning ? "on" : "off"} [o] toggle
				</Text>
			</Box>

			<Box marginTop={1}>
				<Text>
					[c] {controlHint} Commands: {selectedState.commandCount} Last:{" "}
					{lastCommand}
					{commandHint}
				</Text>
			</Box>

			{actionError ? (
				<Box marginTop={1}>
					<Text color="red">Action error: {actionError}</Text>
				</Box>
			) : null}

			{selectedState.lastError ? (
				<Box marginTop={1}>
					<Text color="red">Last error: {selectedState.lastError}</Text>
				</Box>
			) : null}
		</Box>
	)
}
