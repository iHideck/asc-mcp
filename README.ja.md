# asc-mcp

[English](README.md) | 日本語

App Store Connect API を呼ぶ MCP サーバー（非公式）。Claude Code のプラグインとして入れ、App Store へのリリース作業を Claude Code に頼めるようにする。

## ツール

| ツール | すること |
| :- | :- |
| `list_apps` | アプリの名前・バンドル ID・Apple ID を返す |
| `get_release_status` | 新しい5つのビルド（処理と TestFlight の状態、配ったグループ、アップロードのときの `ITMS-` の警告）と、公開中の版と次に出す版の状態（著作権を含む）を返す |
| `get_localizations` | 版の言語ごとの文（概要・キーワード・プロモーション用テキスト・新機能・URL）と、App 情報の言語ごとの文（名前・サブタイトル・プライバシーポリシーの URL）を返す |
| `ensure_version` | 次に出す版を用意する。その番号の版が無ければ作り、編集中の版の番号が違えば直す。公開のしかた・段階的リリース・著作権をそろえる。著作権を省き、版に著作権が無ければ、前の版から写す |
| `select_build` | 編集中の版に、審査に出すビルドを選ぶ。処理が済んでいない・期限切れ・内部テスト専用のビルドは選ばない |
| `set_localizations` | 編集中の版と App 情報に、言語ごとの掲載の文を入れる。まだ無い言語は作ってから入れる（App 情報に作るには `name` が要る）。入れる前に、言語コード・上限の文字数・URL の形を確かめる |
| `replace_screenshots` | 編集中の版の、1つの言語の1つの欄の画面写真を、渡したファイルに入れ替える。上げる前に、写真の形式と大きさが欄に合うかを確かめる |
| `set_review_detail` | 編集中の版の、審査メモと、サインインが要るかを入れる。連絡先や審査用のアカウントが欠けていれば知らせる |
| `copy_review_contact` | 審査の連絡先を、ほかのアプリの版から写す。連絡先の中身は返さない |
| `set_app_info` | App 情報のカテゴリ・コンテンツ配信権・年齢制限の答えを入れ、App Store が決めた年齢を返す。答えていない年齢制限の質問を知らせる |
| `set_price` | アプリの価格を入れる（いまは無料だけ）。呼ぶたびに、利用者の確認が要る |
| `set_availability` | 配信する国を入れる。国の一覧か、同じ国にするアプリを渡す。呼ぶたびに、利用者の確認が要る |
| `get_subscriptions` | アプリの自動更新サブスクのグループと商品を、言語ごとの文・審査用の写真・国・価格・無料期間とあわせて返す |
| `ensure_subscription` | サブスクのグループと商品を作るか、そろえる（商品 ID・期間・参照名・ファミリー共有・各言語の表示名と説明・審査メモ・審査用の写真）。違う値だけを変える |
| `set_subscription_price` | サブスクを売る国と、基準の国の価格から決めた全部の国の価格を入れる。呼ぶたびに、利用者の確認が要る |
| `set_introductory_offer` | 新しく入る人向けの無料期間を、国ごとに入れる。呼ぶたびに、利用者の確認が要る |
| `submit_for_review` | 版を審査に出す。出す前に、著作権と、選んであるビルドを確かめる。断られたら、答えていない年齢制限の質問を挙げる。`cancel_review` で取り下げられる |
| `cancel_review` | 審査待ち・審査中の版を、審査から取り下げる |
| `release_version` | 審査が通って公開を待っている版を公開する。取り消せない。呼ぶたびに、利用者の確認が要る |
| `set_phased_release` | 段階的リリースを、止める・再開する・全員に出す。全員に出すのは取り消せない。呼ぶたびに、利用者の確認が要る |
| `ensure_analytics_reports` | アプリのアナリティクスのレポートのリクエストが無ければ作り、読めるレポートの名前を返す。最初のレポートができるのは 1〜2 日後 |
| `get_analytics_report` | アナリティクスのレポート（インプレッション・プロダクトページの閲覧・ダウンロード・セッションなど）を期間で読み、行を絞ってまとめ、足した数を返す。レポートがまだできていないときは、そう返す |
| `get_sales_report` | 売上とトレンドのレポートを1日分読み、行を絞ってまとめ、足した数を返す |

## スキル

`/asc-mcp:release` は、次の版の準備（初めて出すアプリの設定を含む）から、審査に出して公開するまでを、上のツールでつなぐ。「次の版を出したい」「審査に出して」と頼むと、Claude が読み込む。

`/asc-mcp:analytics` は、アプリのインプレッション・プロダクトページの閲覧・初回ダウンロード・コンバージョン・売上を、国別にも読む。リテンションは API に無い。「先週のダウンロード数は？」と聞くと、Claude が読み込む。

## 入れ方

MCP サーバーは、PATH にある Node（24 以上）で動く。

1. App Store Connect の「ユーザとアクセス」→「統合」→「App Store Connect API」で、チームキーを作る。ロールは App Manager か Admin にする。`ensure_analytics_reports` には Admin が要る。そのロールのチームキーがもうあれば、それを使える
2. ダウンロードした `AuthKey_<Key ID>.p8` を `~/.appstoreconnect/private_keys/` に置き、`chmod 600` で自分だけが読めるようにする
3. Claude Code で、次を打つ

   ```
   /plugin marketplace add iHideck/asc-mcp
   /plugin install asc-mcp@asc-mcp
   ```

4. 設定の画面で、Issuer ID と Key ID を入れる。あとから直すときは、`/plugin configure asc-mcp@asc-mcp` を打つ

## ほかの MCP クライアントで使う

MCP サーバーは、Claude Desktop や Cursor など、ほかの MCP クライアントでも動く。スキル `release` は、Claude Code でだけ使える。

1. [入れ方](#入れ方)の 1 と 2 を済ませる
2. クライアントの MCP の設定に、サーバーを足す。Claude Desktop は「設定」→「開発者」→「設定を編集」、Cursor は `~/.cursor/mcp.json` を開く

   ```json
   {
     "mcpServers": {
       "asc": {
         "command": "npx",
         "args": ["-y", "@ihideck/asc-mcp"],
         "env": {
           "ASC_ISSUER_ID": "<Issuer ID>",
           "ASC_KEY_ID": "<Key ID>"
         }
       }
     }
   }
   ```

3. クライアントを起動し直す。ツールの一覧に `list_apps` が出れば、つながっている

ソースから動かすときは、`git clone https://github.com/iHideck/asc-mcp.git` と `npm ci --prefix asc-mcp/plugin` を打ち、`"command": "node"`・`"args": ["/絶対パス/asc-mcp/plugin/src/index.ts"]` にする。

公開する・価格や配信する国を変えるツールで確認を出すのは、Claude Code だけ。ほかのクライアントでは、それらのツールを呼ぶ前に確認を出すよう、クライアントを設定する。書くツールが送らずにリクエストを返すようにするには、`env` に `"ASC_READ_ONLY": "1"` を足す。

## 開発

プラグインは `plugin/` にある。Claude Code がプラグインと一緒に入れるのは、`plugin/package.json` の依存だけ。ESLint などの開発の道具は、ルートの `package.json` に置く。

| コマンド | すること |
| :- | :- |
| `make setup` | 依存を入れ、Apple の OpenAPI の仕様を落とす |
| `make check` | CI と同じ検査（ESLint・整形・型の検査・テスト）を流す |
| `make download-openapi` | Apple がいま配っている OpenAPI の仕様を、`.local/` に落とし直す |
| `make validate-plugin` | プラグインとマーケットプレイスの設定を検査する |
| `make run-claude` | 手元のソースの MCP サーバーをつないで、Claude Code を起動する |
| `make pack-npm` | npm に出すパッケージ（`@ihideck/asc-mcp`）を、`plugin/` に `.tgz` で作る |

テストは、送るリクエストのパス・引数・値が、OpenAPI の仕様にあるかを確かめる。CI は毎回、Apple がいま配っている仕様を落として照らす。

手元のソースを本物の API で試すときは、Issuer ID と Key ID を環境変数 `ASC_ISSUER_ID` と `ASC_KEY_ID` に入れてから、`make run-claude` を打つ。プラグインの設定は、`claude --plugin-dir` で読んだプラグインには渡らない。このとき、書くツールは App Store Connect を変えず、送るはずだったリクエストをエラーで返す。本当に書いて試すときは、`ASC_READ_ONLY=0` も入れる。

## 報告と貢献

不具合の報告・要望・PR は、[CONTRIBUTING.md](CONTRIBUTING.md) を読む。脆弱性は、[SECURITY.md](SECURITY.md) の手順で知らせる。

## ライセンス

[MIT](LICENSE)
