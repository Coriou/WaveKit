.PHONY: help docker-build docker-build-full docker-build-core docker-build-sdrpp \
        docker-dev docker-prod docker-push docker-clean docker-logs \
        docker-shell docker-compose-up docker-compose-down

# WaveKit Docker Makefile
# Quick commands for development and deployment
# Usage: make [target]

.DEFAULT_GOAL := help

# Variables
REGISTRY ?= 
IMAGE_NAME ?= wavekit
TAG ?= latest
BUILDKIT ?= 1
COMPOSE_DEV := docker-compose -f docker-compose.dev.yml
COMPOSE_PROD := docker-compose -f docker-compose.prod.yml -f docker-compose.override.yml

# Colors for output
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[1;33m
RED := \033[0;31m
NC := \033[0m # No Color

help: ## Show this help message
	@echo "$(BLUE)WaveKit Docker Commands$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "$(GREEN)%-25s$(NC) %s\n", $$1, $$2}'

# Docker Build Commands

docker-build: ## Build all Docker images (full, core, sdrpp)
	@echo "$(BLUE)Building all WaveKit images...$(NC)"
	@DOCKER_BUILDKIT=$(BUILDKIT) ./docker/build.sh full $(TAG)
	@DOCKER_BUILDKIT=$(BUILDKIT) ./docker/build.sh core $(TAG)-core
	@DOCKER_BUILDKIT=$(BUILDKIT) ./docker/build.sh sdrpp $(TAG)-sdrpp
	@echo "$(GREEN)✅ All images built successfully$(NC)"

docker-build-full: ## Build full mode image
	@echo "$(BLUE)Building WaveKit full mode...$(NC)"
	@DOCKER_BUILDKIT=$(BUILDKIT) ./docker/build.sh full $(TAG)
	@docker image inspect $(IMAGE_NAME):$(TAG) --format="Size: {{.Size}}" | numfmt --to=iec

docker-build-core: ## Build core mode image
	@echo "$(BLUE)Building WaveKit core mode...$(NC)"
	@DOCKER_BUILDKIT=$(BUILDKIT) ./docker/build.sh core $(TAG)-core

docker-build-sdrpp: ## Build SDR++-only mode image
	@echo "$(BLUE)Building WaveKit SDR++ mode...$(NC)"
	@DOCKER_BUILDKIT=$(BUILDKIT) ./docker/build.sh sdrpp $(TAG)-sdrpp

# Docker Compose Commands

docker-dev: docker-build-core ## Start development environment
	@echo "$(BLUE)Starting WaveKit development environment...$(NC)"
	@$(COMPOSE_DEV) up -d
	@echo "$(GREEN)✅ Development environment started$(NC)"
	@echo ""
	@echo "$(YELLOW)Services:$(NC)"
	@echo "  API:       http://localhost:9000"
	@echo "  WebSocket: ws://localhost:4713"
	@echo "  Audio:     nc localhost 8080"
	@echo "  IDE:       http://localhost:3000"

docker-prod: docker-build ## Start production environment
	@echo "$(BLUE)Starting WaveKit production environment...$(NC)"
	@$(COMPOSE_PROD) up -d
	@echo "$(GREEN)✅ Production environment started$(NC)"
	@echo ""
	@$(COMPOSE_PROD) ps

docker-compose-up: ## Start Docker Compose
	@$(COMPOSE_DEV) up

docker-compose-down: ## Stop Docker Compose
	@echo "$(YELLOW)Stopping Docker Compose...$(NC)"
	@$(COMPOSE_DEV) down
	@echo "$(GREEN)✅ Stopped$(NC)"

docker-compose-logs: ## Show Docker Compose logs
	@$(COMPOSE_DEV) logs -f

# Docker Utilities

docker-push: ## Push images to registry (requires REGISTRY variable)
	@if [ -z "$(REGISTRY)" ]; then \
		echo "$(RED)Error: REGISTRY not set$(NC)"; \
		echo "Usage: make docker-push REGISTRY=docker.io/myuser"; \
		exit 1; \
	fi
	@echo "$(BLUE)Pushing images to $(REGISTRY)...$(NC)"
	@./docker/push.sh $(TAG) $(REGISTRY)

docker-logs: ## Tail WaveKit logs
	@docker logs -f wavekit

docker-logs-api: ## Tail API logs
	@docker exec -it wavekit tail -f /var/log/wavekit/wavekit.log

docker-logs-sdrpp: ## Tail SDR++ logs
	@docker exec -it wavekit tail -f /var/log/wavekit/sdrpp.log

docker-logs-decoders: ## Tail decoder logs
	@docker exec -it wavekit tail -f /var/log/wavekit/decoders.log

docker-shell: ## Open shell in WaveKit container
	@docker exec -it wavekit /bin/bash

docker-status: ## Show WaveKit service status
	@echo "$(BLUE)Service Status:$(NC)"
	@docker exec wavekit s6-rc-status || echo "Container not running"
	@echo ""
	@echo "$(BLUE)Container Health:$(NC)"
	@docker inspect wavekit --format='{{json .State.Health}}' | jq . || echo "Container not running"

docker-health: ## Check container health
	@docker exec wavekit /etc/s6-overlay/scripts/healthcheck.sh

docker-ps: ## List running containers
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

docker-clean: ## Remove WaveKit containers and volumes
	@echo "$(YELLOW)Cleaning up WaveKit containers...$(NC)"
	@docker-compose -f docker-compose.dev.yml down -v 2>/dev/null || true
	@docker-compose -f docker-compose.prod.yml down -v 2>/dev/null || true
	@docker volume rm wavekit-config wavekit-logs recordings 2>/dev/null || true
	@echo "$(GREEN)✅ Cleanup complete$(NC)"

docker-prune: ## Prune unused Docker resources
	@echo "$(YELLOW)Pruning unused resources...$(NC)"
	@docker image prune -a -f --filter "label!=keep=true"
	@docker container prune -f
	@docker volume prune -f
	@docker network prune -f
	@echo "$(GREEN)✅ Pruned successfully$(NC)"

# Testing & Validation

docker-test: ## Run tests in container
	@docker run --rm \
		-v $(PWD):/app \
		-w /app \
		$(IMAGE_NAME):$(TAG) \
		npm test

docker-test-coverage: ## Run tests with coverage
	@docker run --rm \
		-v $(PWD):/app \
		-w /app \
		$(IMAGE_NAME):$(TAG) \
		npm run test:coverage

docker-lint: ## Run linting in container
	@docker run --rm \
		-v $(PWD):/app \
		-w /app \
		$(IMAGE_NAME):$(TAG) \
		npm run lint

# Information & Debugging

docker-info: ## Show Docker build info
	@echo "$(BLUE)Docker Build Configuration:$(NC)"
	@echo "Registry:      $(REGISTRY)"
	@echo "Image:         $(IMAGE_NAME)"
	@echo "Tag:           $(TAG)"
	@echo "BuildKit:      $(BUILDKIT)"
	@echo ""
	@echo "$(BLUE)Environment:$(NC)"
	@env | grep -E "^(DOCKER_|BUILDKIT_)" || echo "None set"

docker-inspect: ## Inspect built image
	@docker inspect $(IMAGE_NAME):$(TAG) | jq '.[0] | {Repo: .RepoTags, Size: .Size, Created: .Created, Architecture: .Architecture, Os: .Os}'

docker-history: ## Show image layer history
	@docker history --human $(IMAGE_NAME):$(TAG)

# Convenience

install-buildx: ## Install Docker buildx (for multi-platform builds)
	@echo "$(BLUE)Installing docker buildx...$(NC)"
	@docker buildx create --name wavekit-builder 2>/dev/null || echo "Builder already exists"
	@docker buildx use wavekit-builder

demo: docker-build-full docker-dev ## Build and run demo
	@echo ""
	@echo "$(GREEN)✅ Demo ready!$(NC)"
	@echo ""
	@echo "API Health:    curl http://localhost:9000/health"
	@echo "Full Status:   curl http://localhost:9000/api/status"
	@echo "WebSocket:     wscat -c ws://localhost:4713"
	@echo ""
	@echo "View logs:     make docker-logs"
	@echo "Stop demo:     make docker-compose-down"
