# asc-mcp

App Store Connect API を呼ぶ MCP サーバー（非公式）。Claude Code のプラグインとして入れ、App Store へのリリース作業を Claude Code に頼めるようにする。

## ツール

| ツール | すること |
| :- | :- |
| `list_apps` | アプリの名前・バンドル ID・Apple ID を返す |
| `get_release_status` | 新しい5つのビルド（処理と TestFlight の状態、配ったグループ、アップロードのときの `ITMS-` の警告）と、公開中の版と次に出す版の状態を返す |
| `get_localizations` | 版の言語ごとの文（概要・キーワード・プロモーション用テキスト・新機能・URL）と、App 情報の言語ごとの文（名前・サブタイトル・プライバシーポリシーの URL）を返す |
| `ensure_version` | 次に出す版を用意する。その番号の版が無ければ作り、編集中の版の番号が違えば直す。公開のしかたと段階的リリースをそろえる |
| `select_build` | 編集中の版に、審査に出すビルドを選ぶ。処理が済んでいない・期限切れ・内部テスト専用のビルドは選ばない |
| `set_localizations` | 編集中の版と App 情報に、言語ごとの掲載の文を入れる。入れる前に、上限の文字数と URL の形を確かめる |
| `set_review_detail` | 編集中の版の、審査メモと、サインインが要るかを入れる。連絡先や審査用のアカウントが欠けていれば知らせる |
| `submit_for_review` | 版を審査に出す。出す前に、選んであるビルドを確かめる。呼ぶたびに、利用者の確認が要る |
| `cancel_review` | 審査待ち・審査中の版を、審査から取り下げる。呼ぶたびに、利用者の確認が要る |
| `release_version` | 審査が通って公開を待っている版を公開する。取り消せない。呼ぶたびに、利用者の確認が要る |
| `set_phased_release` | 段階的リリースを、止める・再開する・全員に出す。全員に出すのは取り消せない。呼ぶたびに、利用者の確認が要る |

## 入れ方

MCP サーバーは、PATH にある Node（24 以上）で動く。

1. App Store Connect の「ユーザとアクセス」→「統合」→「App Store Connect API」で、チームキーを作る。ロールは App Manager か Admin にする。そのロールのチームキーがもうあれば、それを使える
2. ダウンロードした `AuthKey_<Key ID>.p8` を `~/.appstoreconnect/private_keys/` に置き、`chmod 600` で自分だけが読めるようにする
3. Claude Code で、次を打つ

   ```
   /plugin marketplace add iHideck/asc-mcp
   /plugin install asc-mcp@asc-mcp
   ```

4. 設定の画面で、Issuer ID と Key ID を入れる。あとから直すときは、`/plugin configure asc-mcp@asc-mcp` を打つ

## 開発

プラグインは `plugin/` にある。Claude Code がプラグインと一緒に入れるのは、`plugin/package.json` の依存だけ。ESLint などの開発の道具は、ルートの `package.json` に置く。

| コマンド | すること |
| :- | :- |
| `make setup` | 依存を入れ、Apple の OpenAPI の仕様を落とす |
| `make check` | CI と同じ検査（ESLint・整形・型の検査・テスト）を流す |
| `make download-openapi` | Apple がいま配っている OpenAPI の仕様を、`.local/` に落とし直す |
| `make validate-plugin` | プラグインとマーケットプレイスの設定を検査する |
| `make run-claude` | 手元のソースの MCP サーバーをつないで、Claude Code を起動する |

テストは、送るリクエストのパス・引数・値が、OpenAPI の仕様にあるかを確かめる。CI は毎回、Apple がいま配っている仕様を落として照らす。

手元のソースを本物の API で試すときは、Issuer ID と Key ID を環境変数 `ASC_ISSUER_ID` と `ASC_KEY_ID` に入れてから、`make run-claude` を打つ。プラグインの設定は、`claude --plugin-dir` で読んだプラグインには渡らない。このとき、書くツールは App Store Connect を変えず、送るはずだったリクエストをエラーで返す。本当に書いて試すときは、`ASC_READ_ONLY=0` も入れる。
