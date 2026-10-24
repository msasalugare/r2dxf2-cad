SHELL := /bin/bash

.PHONY: build run test lint e2e multiarch clean

build: ## Build the Docker image
	docker compose build

run: ## Run the app at http://localhost:8080
	docker compose up

test: ## Run native Rust tests + web unit tests + type check
	cargo test
	npm --prefix web run test
	npm --prefix web run lint

lint: ## Rust fmt/clippy + web lint
	cargo fmt --check
	cargo clippy --workspace --all-targets -- -D warnings
	npm --prefix web run lint

e2e: ## Build+run container and run Playwright e2e against it
	docker compose up -d --build
	npm --prefix web run e2e
	docker compose down

multiarch: ## Build linux/amd64 + linux/arm64 (requires docker buildx)
	docker buildx build --platform linux/amd64,linux/arm64 -t rasterfit:multi .

clean: ## Remove container, local images and build artifacts
	docker compose down --rmi local -v
