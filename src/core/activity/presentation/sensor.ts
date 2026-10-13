import type { DecodePresentation } from "../types.js"
import {
	clampTitle,
	entityKey,
	numberField,
	presentation,
	readPayload,
	stripControls,
	takeFields,
} from "./budget.js"

/** Spaces become underscores. A colon or a control character rejects the token. */
function sensorToken(raw: string): string | null {
	const value = stripControls(raw).trim().replace(/ /g, "_")
	if (value === "" || value.includes(":") || value.includes("\u0000"))
		return null
	return value
}

function idToken(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value))
		return sensorToken(String(value))
	if (typeof value === "string") return sensorToken(value)
	return null
}

/**
 * rtl_433 sensor. The key is `sensor:<model>-<id>[-<channel>]`.
 * A signal whose model is not a string is not a sensor.
 */
export function presentSensor(data: unknown): DecodePresentation | undefined {
	const payload = readPayload(data)
	if (!payload) return undefined
	if (typeof payload["model"] !== "string") return undefined
	const model = stripControls(payload["model"]).trim()
	if (model === "") return undefined
	const modelToken = sensorToken(model)
	const id = idToken(payload["id"])
	const channel = payload["channel"]
	const channelToken =
		channel === undefined || channel === null ? null : idToken(channel)
	let key: string | null = null
	if (modelToken !== null && id !== null) {
		let body = `${modelToken}-${id}`
		if (channelToken !== null) body = `${body}-${channelToken}`
		key = entityKey("sensor", body)
	}
	const title = clampTitle(id === null ? model : `${model} ${id}`)
	return presentation({
		category: "sensors",
		protocol: "rtl_433",
		entityKey: key,
		title,
		fields: takeFields(
			[
				{
					key: "temperature_C",
					label: "Temperature",
					unit: "°C",
					value: numberField(payload, "temperature_C"),
				},
				{
					key: "humidity",
					label: "Humidity",
					unit: "%",
					value: numberField(payload, "humidity"),
				},
				{ key: "battery_ok", label: "Battery", value: payload["battery_ok"] },
				{ key: "channel", label: "Channel", value: payload["channel"] },
			],
			{ title },
		),
	})
}
