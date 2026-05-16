# WaveKit buildx bake configuration.
#
# Canonical entry point for every image build (local + CI). Replaces the
# per-mode docker/build.sh wrapper. The Makefile and CI workflow invoke
# `docker buildx bake --file docker/bake.hcl <target-or-group>`; no plain
# `docker`+`build` (without `buildx`) survives anywhere — see Req 5.1.
#
# Cache strategy (design.md §4):
#   - `cache-from` pulls per-stage refs from GHCR. Misses fall through
#     silently per Req 4.3 (no auth error if the contributor isn't logged
#     in to ghcr.io).
#   - `cache-to` writes are gated by CACHE_FROM_ONLY. Defaults to "true"
#     so local builds never push cache. CI on main flips it to "false" to
#     publish `mode=max` cache for cold-build hits on every other machine.
#
# Variables can be overridden via `--set` on the CLI:
#   docker buildx bake --file docker/bake.hcl default --set "REGISTRY=..."

variable "REGISTRY" {
	default = "ghcr.io/coriou/wavekit"
}

variable "TAG" {
	default = "latest"
}

variable "CACHE_FROM_ONLY" {
	default = "true"
}

# Per-stage cache ref helper. Returns the single-element cache-from list
# for a named Dockerfile stage. Used inside concat() in each target.
function "cache" {
	params = [stage]
	result = [
		"type=registry,ref=${REGISTRY}:cache-${stage}",
	]
}

# Abstract base inherited by every concrete target. Centralises context,
# Dockerfile path, and multi-arch platform list.
target "_base" {
	context    = "."
	dockerfile = "Dockerfile"
	platforms  = ["linux/amd64", "linux/arm64"]
}

# Full image: every decoder including SDR++. Maps to Dockerfile stage `final`.
target "final" {
	inherits = ["_base"]
	target   = "final"
	tags     = ["${REGISTRY}:${TAG}"]
	cache-from = concat(
		cache("final"),
		cache("final-base"),
		cache("node-build"),
		cache("sdrpp-build"),
		cache("dsd-fme-build"),
		cache("multimon-ng-build"),
		cache("rtl433-build"),
		cache("acarsdec-build"),
		cache("ais-catcher-build"),
		cache("direwolf-build"),
		cache("dumpvdl2-build"),
		cache("readsb-build"),
		cache("soapy-rtltcp-build"),
		cache("csdr-build"),
		cache("lora-build"),
		cache("base-build"),
		cache("runtime-base"),
	)
	cache-to = equal(CACHE_FROM_ONLY, "true") ? [] : [
		"type=registry,ref=${REGISTRY}:cache-final,mode=max",
	]
}

# Core image: every decoder MINUS SDR++. Maps to Dockerfile stage `final-core`.
# Property 8: no sdrpp-build in the cache chain.
target "final-core" {
	inherits = ["_base"]
	target   = "final-core"
	tags     = ["${REGISTRY}:${TAG}-core"]
	cache-from = concat(
		cache("final-core"),
		cache("final-base"),
		cache("node-build"),
		cache("dsd-fme-build"),
		cache("multimon-ng-build"),
		cache("rtl433-build"),
		cache("acarsdec-build"),
		cache("ais-catcher-build"),
		cache("direwolf-build"),
		cache("dumpvdl2-build"),
		cache("readsb-build"),
		cache("soapy-rtltcp-build"),
		cache("csdr-build"),
		cache("lora-build"),
		cache("base-build"),
		cache("runtime-base"),
	)
	cache-to = equal(CACHE_FROM_ONLY, "true") ? [] : [
		"type=registry,ref=${REGISTRY}:cache-final-core,mode=max",
	]
}

# SDR++ standalone image: SDR++ binaries + minimal s6 overlay.
# Maps to Dockerfile stage `final-sdrpp`.
target "final-sdrpp" {
	inherits = ["_base"]
	target   = "final-sdrpp"
	tags     = ["${REGISTRY}:${TAG}-sdrpp"]
	cache-from = concat(
		cache("final-sdrpp"),
		cache("sdrpp-build"),
		cache("base-build"),
		cache("runtime-base"),
	)
	cache-to = equal(CACHE_FROM_ONLY, "true") ? [] : [
		"type=registry,ref=${REGISTRY}:cache-final-sdrpp,mode=max",
	]
}

# Interactive demod tooling image: dsd-fme, multimon-ng, csdr, rtl-sdr.
# Maps to Dockerfile stage `final-demod`. No SDR++ in this chain.
target "final-demod" {
	inherits = ["_base"]
	target   = "final-demod"
	tags     = ["${REGISTRY}:${TAG}-demod"]
	cache-from = concat(
		cache("final-demod"),
		cache("dsd-fme-build"),
		cache("multimon-ng-build"),
		cache("csdr-build"),
		cache("base-build"),
		cache("runtime-base"),
	)
	cache-to = equal(CACHE_FROM_ONLY, "true") ? [] : [
		"type=registry,ref=${REGISTRY}:cache-final-demod,mode=max",
	]
}

# CI helper: PR sanity build. Currently aliases final-core; CI uses it via
# `--target ci-core` so we can later cheapen the PR build (e.g. amd64-only,
# smaller cache chain) without touching the CI workflow.
target "ci-core" {
	inherits = ["final-core"]
}

# Default group: built locally by `make docker-build` and pushed by CI on
# main. Demod tooling is opt-in via the separate demod group.
group "default" {
	targets = ["final", "final-core", "final-sdrpp"]
}

group "demod" {
	targets = ["final-demod"]
}
