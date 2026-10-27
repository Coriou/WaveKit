import type { DecodePresentation } from "../types.js"
import {
	clampTitle,
	entityKey,
	asNumber,
	asNumberOrString,
	asScalar,
	asString,
	numberField,
	objectSchema,
	parsePayload,
	presentation,
	stripControls,
	takeFields,
} from "./budget.js"

const sensorPayload = objectSchema({
	model: asString,
	mode: asScalar,
	M: asScalar,
	type_string: asScalar,
	id: asNumberOrString,
	channel: asNumberOrString,
	temperature_C: asNumber,
	humidity: asNumber,
	battery_ok: asScalar,
})

/** Spaces become underscores. A colon or a control character rejects the token. */
function sensorToken(raw: string): string | null {
	if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null
	const value = raw.trim().replace(/ /g, "_")
	if (value === "" || value.includes(":")) return null
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
	const payload = parsePayload(sensorPayload, data)
	if (!payload) return undefined
	const modelRaw = payload["model"]
	if (typeof modelRaw !== "string") return undefined
	const model = stripControls(modelRaw).trim()
	if (model === "") return undefined
	const modelToken = sensorToken(modelRaw)
	const id = idToken(payload["id"])
	const channel = payload["channel"]
	const channelPresent = channel !== undefined && channel !== null
	const channelToken = channelPresent ? idToken(channel) : null
	let key: string | null = null
	if (
		modelToken !== null &&
		id !== null &&
		(!channelPresent || channelToken !== null)
	) {
		let body = `${modelToken}-${id}`
		if (channelToken !== null) body = `${body}-${channelToken}`
		key = entityKey("sensor", body)
	}
	const title = clampTitle(id === null ? model : `${model} ${id}`)
	return presentation({
		category: "sensors",
		protocol: model === "Wireless-MBus" ? "wmbus" : "rtl_433",
		entityKey: key,
		title,
		fields: takeFields(
			[
				...(model === "Wireless-MBus"
					? [
							{ key: "mode", label: "Mode", value: payload["mode"] },
							{ key: "M", label: "Manufacturer", value: payload["M"] },
							{
								key: "type_string",
								label: "Meter type",
								value: payload["type_string"],
							},
						]
					: []),
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
