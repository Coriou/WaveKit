# WaveKit Makefile
# Lifecycle-focused targets for dev, build, push, and ops.
# Run `make help` for the full inventory.

.DEFAULT_GOAL := help

.PHONY: help \
	dev dev-dashboard dev-dashboard-build dev-configs \
	dev-stack dev-stack-down dev-stack-logs dev-shell dev-status \
	docker-init docker-build docker-push docker-clean docker-prune \
	demod-test \
	sdr-host-build sdr-host-build-multi sdr-host-install sdr-host-init \
	sdr-host-up sdr-host-update sdr-host-down sdr-host-restart \
	sdr-host-logs sdr-host-status sdr-host-health sdr-host-compose-update \
	sdr-host-clean \
	fixtures-download fixtures-download-all fixtures-convert \
	fixtures-test fixtures-test-local

# SDR-host variables (preserved from prior Makefile)
SDR_HOST_TAG ?= latest
SDR_HOST_PLATFORMS ?= linux/arm64

# Dev container (used by fixtures-test which exec's into the dev stack)
DEV_CONTAINER ?= wavekit-api

# Colors for retained sdr-host-* / fixtures-* output (newly-introduced
# targets below are emoji-free and ANSI-free per Requirement 6.3).
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[1;33m
RED := \033[0;31m
NC := \033[0m

help: ## Show this help message
	@awk 'BEGIN {FS = ":.*?## "} \
		/^# === / {sub(/^# === /, ""); sub(/ ===$$/, ""); printf "\n%s\n", $$0; next} \
		/^[a-zA-Z][a-zA-Z0-9_-]+:.*?## / {printf "  %-25s %s\n", $$1, $$2}' \
		$(MAKEFILE_LIST)

# === Native dev loop (no Docker) ===

dev: ## Run app natively with hot-reload (esbuild watch + node --watch, no Docker)
	@pnpm dev

dev-dashboard: dev-dashboard-build ## Launch Ink/React CLI dashboard (interactive)
	@WAVEKIT_WS_URLS=ws://localhost:9000/ws,ws://localhost:4713/ws node ./cli/dist/cli.js

dev-dashboard-build: ## Build CLI dashboard bundle (installs cli deps if missing)
	@test -d cli/node_modules || pnpm --filter @wavekit/cli install --silent
	@rm -rf cli/node_modules/.cache cli/dist
	@pnpm --filter @wavekit/cli build

dev-configs: ## List available configs in config/
	@echo "[wavekit] Available configs:"
	@ls -1 config/*.yaml | xargs -I {} basename {} .yaml | sort

# === Container integration (full stack) ===

dev-stack: ## Bring up dev profile (sdrpp-server + wavekit-api) with build
	docker compose --profile dev up --build

dev-stack-down: ## Stop dev profile and remove containers
	docker compose --profile dev down

dev-stack-logs: ## Follow logs from dev profile services
	docker compose --profile dev logs -f

dev-shell: ## Open shell in dev wavekit-api container (must be running via dev-stack)
	docker compose --profile dev exec wavekit-api /bin/bash

dev-status: ## Show dev stack container status and probe /health
	@docker compose --profile dev ps
	@echo
	@curl -fsS http://localhost:9000/health 2>/dev/null && echo " OK" || echo "[wavekit] /health not reachable"

# === Build / push ===

docker-init: ## Bootstrap buildx builder + networks + volumes (run once)
	bash docker/init.sh

docker-build: ## Build all default-group images via buildx bake (final, final-core, final-sdrpp)
	docker buildx bake --file docker/bake.hcl default

docker-push: ## Push images to GHCR (multi-arch, mode=max cache write)
	bash docker/push.sh

docker-clean: ## Stop compose profiles and remove named volumes
	docker compose --profile dev down -v --remove-orphans 2>/dev/null || true
	docker compose --profile prod-single-host down -v --remove-orphans 2>/dev/null || true
	docker compose --profile prod-distributed down -v --remove-orphans 2>/dev/null || true

docker-prune: ## Prune unused Docker resources (dangling images, stopped containers, networks)
	docker system prune -f

# === Demod tooling ===

demod-test: ## Launch interactive demod test environment (sox/ffmpeg/dsd-fme/multimon-ng/csdr)
	docker compose --profile demod-test run --rm demod-test

# === Pi-hosted SDR ===

sdr-host-build: ## Build & publish sdr-host image (default: arm64)
	@bash ./packages/sdr-host/scripts/build-publish.sh --tag $(SDR_HOST_TAG) --platform $(SDR_HOST_PLATFORMS)

sdr-host-build-multi: ## Build & publish multi-arch sdr-host image
	@bash ./packages/sdr-host/scripts/build-publish.sh --tag $(SDR_HOST_TAG) --multi-arch

sdr-host-install: ## Install docker + deps on host (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh install

sdr-host-init: ## Prepare host config files (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh init

sdr-host-up: ## Start sdr-host container (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh up

sdr-host-update: ## Pull latest image + recreate container (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh update

sdr-host-down: ## Stop sdr-host container (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh down

sdr-host-restart: ## Restart sdr-host container (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh restart

sdr-host-logs: ## Tail sdr-host logs (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh logs

sdr-host-status: ## Show sdr-host status (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh status

sdr-host-health: ## Check sdr-host health endpoints (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh health

sdr-host-compose-update: ## Refresh sdr-host compose file (run on host)
	@bash ./packages/sdr-host/scripts/sdr-host.sh compose-update

sdr-host-clean: ## Docker cleanup helper (run on host)
	@bash ./packages/sdr-host/scripts/docker-cleanup.sh

# === Fixtures ===

fixtures-download: ## Download test fixtures (small ones by default)
	@./fixtures/download.sh

fixtures-download-all: ## Download ALL test fixtures (large files!)
	@./fixtures/download.sh --all

fixtures-convert: ## Convert fixtures to decoder-ready formats
	@./fixtures/convert.sh

fixtures-test: ## Run decoder tests against fixtures (in container)
	@docker exec -it $(DEV_CONTAINER) ./fixtures/test-decoders.sh

fixtures-test-local: ## Run decoder tests locally (if decoders installed)
	@./fixtures/test-decoders.sh
