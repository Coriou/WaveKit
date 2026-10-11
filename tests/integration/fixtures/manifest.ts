import { readFileSync } from "node:fs"
import { parse } from "yaml"
import {
	CONTAINER_SAFE_ID,
	CandidateSchema,
	FixtureFormatSchema,
	FixtureRoleSchema,
	FixtureSchema,
	ManifestSchema,
	type Fixture,
	type Manifest,
} from "../../../src/core/fixtures/manifest-schema.js"

// The one sanctioned re-export (Task 34a): the schema moved to src/, importers keep this path
export {
	CONTAINER_SAFE_ID,
	CandidateSchema,
	FixtureFormatSchema,
	FixtureRoleSchema,
	FixtureSchema,
	ManifestSchema,
	type Fixture,
	type Manifest,
}

export function parseManifest(text: string): Manifest {
	return ManifestSchema.parse(parse(text))
}

export function loadManifest(path = "fixtures/manifest.yaml"): Manifest {
	return parseManifest(readFileSync(path, "utf8"))
}
