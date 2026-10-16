import { z } from "zod"
import { StationConfigSchema } from "../../config.js"
import { BAND_REGIONS } from "../../decoders/band-region.js"
import { WaveKitError } from "../../utils/errors.js"
import type { FastifyPluginAsync } from "fastify"
import type { StationIdentity } from "@wavekit/api-types"

const provenance = z.enum(["default", "yaml", "env"])
const stringField = (value: z.ZodString) =>
	z.object({ value: value.nullable(), provenance }).strict()
const numberField = (value: z.ZodNumber) =>
	z.object({ value: value.nullable(), provenance }).strict()
const shape = StationConfigSchema.shape
const stationSchema = z
	.object({
		name: stringField(shape.name.unwrap()),
		lat: numberField(shape.lat.unwrap()),
		lon: numberField(shape.lon.unwrap()),
		altM: numberField(shape.altM.unwrap()),
		callsign: stringField(shape.callsign.unwrap()),
		country: z
			.object({ value: shape.country.unwrap().nullable(), provenance })
			.strict(),
		effectiveCountry: shape.country.unwrap().nullable(),
		region: z.enum(BAND_REGIONS),
	})
	.strict()
	.refine(value => value.effectiveCountry === value.country.value)

export interface StationRoutesOptions {
	station: StationIdentity
}
/** Read-only snapshot; inherits root access admission in both compositions. */
export const stationRoutes: FastifyPluginAsync<StationRoutesOptions> = async (
	app,
	options,
) => {
	const parsed = stationSchema.safeParse(options.station)
	if (!parsed.success)
		throw new WaveKitError("Invalid station identity", "STATION_INVALID")
	const body = JSON.stringify(parsed.data)
	app.route({
		method: ["GET", "HEAD"],
		url: "/api/station",
		handler: async (request, reply) => {
			reply
				.header("Cache-Control", "no-store")
				.type("application/json")
				.header("Content-Length", Buffer.byteLength(body))
			return reply.send(request.method === "HEAD" ? undefined : body)
		},
	})
}
