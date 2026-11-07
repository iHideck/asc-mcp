.PHONY: help
.DEFAULT_GOAL := help
help: # 使えるコマンドを表示する
	@grep -E '^[a-zA-Z_-]+:.*?# .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?# "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.PHONY: setup
setup: # 依存を入れる
	npm ci

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
