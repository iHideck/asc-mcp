.PHONY: help
.DEFAULT_GOAL := help
help: # 使えるコマンドを表示する
	@grep -E '^[a-zA-Z_-]+:.*?# .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?# "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

OPENAPI_URL := https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip

.PHONY: setup
setup: download-openapi # 依存を入れ（開発の道具と、プラグインが動くのに要るもの）、OpenAPI の仕様を落とす
	npm ci
	npm ci --prefix plugin

.PHONY: download-openapi
# 仕様のファイルには配り方の決まりが書いていないので、リポジトリには入れず、そのつど Apple から落とす
download-openapi: # Apple がいま配っている OpenAPI の仕様を .local/ に落とす（テストが、送るリクエストと照らす）
	mkdir -p .local
	curl -fsSL -o .local/openapi.zip $(OPENAPI_URL)
	unzip -o -q .local/openapi.zip openapi.oas.json -d .local
	rm .local/openapi.zip

.PHONY: check
check: # CI と同じ検査（ESLint・整形・型・テスト）を流す
	npm run lint
	npm run format:check
	npm run typecheck
	npm test

.PHONY: format
format: # Prettier で整形する
	npm run format

.PHONY: validate-plugin
# --strict は、plugin.json に version が無いことを警告して落とす。version を書くと、上げるまで利用者に更新が届かないので書かない
validate-plugin: # プラグインとマーケットプレイスの設定を検査する
	claude plugin validate .
	claude plugin validate plugin
