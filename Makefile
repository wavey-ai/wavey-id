WRANGLER := npx wrangler@4.98.0
CF_WRAP := node scripts/zeroth-cloudflare.mjs
CONFIG := wrangler.zeroth.jsonc

.PHONY: build dev deploy deploy-dry-run types

build:
	cd ../zeroth/crates/zeroth-worker && worker-build --release --no-panic-recovery

dev:
	$(CF_WRAP) $(WRANGLER) dev --config $(CONFIG)

deploy:
	$(CF_WRAP) $(WRANGLER) deploy --config $(CONFIG)

deploy-dry-run:
	$(CF_WRAP) $(WRANGLER) deploy --config $(CONFIG) --dry-run

types:
	$(CF_WRAP) $(WRANGLER) types --config $(CONFIG) src/worker-configuration.d.ts
