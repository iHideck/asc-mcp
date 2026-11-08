---
description: App Store へのリリース（次の版の準備・初めて出すアプリの設定・審査への提出・公開）を、asc-mcp のツールで進める。「次の版を出したい」「初めて App Store に出したい」「審査に出して」「公開して」「段階的リリースを止めて」などと頼まれたときに使う。
---

# App Store へのリリース

asc-mcp のツールで、次の版の準備から公開までを進める。アプリのバンドル ID が分からなければ、`list_apps` で調べる。

外に出るツール（`submit_for_review`・`cancel_review`・`release_version`・`set_phased_release`）は、呼ぶたびに Claude Code が利用者に確認を出す。呼ぶ前に、何をするかを文で見せ、利用者がよいと言ってから呼ぶ。

## 1. いまの状態を見る

1. `get_release_status` で、ビルドと版の状態を読む
2. 次に出す版の番号と、出すビルドを決める。決まっていなければ、利用者に聞く
   - 出せるビルドは、ビルドの版（`version`）が版の番号と同じで、処理が済んだ（`VALID`）もの
   - まだビルドを上げていなければ、アプリのリポジトリの手順（`make release-testflight` など）で上げてもらう。asc-mcp はビルドを上げない

## 2. 版を用意する

書くツールは、いまの状態と比べて差だけを変えるので、同じ呼び出しをやり直してよい。

1. `ensure_version` で版を用意する。公開のしかた（`MANUAL`・`AFTER_APPROVAL`・`SCHEDULED`）と段階的リリースは、利用者が決めたものを渡す
2. `select_build` でビルドを選ぶ
3. `get_localizations` でいまの文を読み、`set_localizations` で変える文を入れる。初めて出す版でなければ、新機能の文（`whatsNew`）は全部の言語に要る
   - アプリのリポジトリに掲載の文の決まりや正本（`docs/release.md` など）があれば、それに従う。入れたあと、正本と食い違いがないかを確かめる
4. `set_review_detail` で、審査メモと、サインインが要るかを入れる。審査の連絡先が欠けていれば、`copy_review_contact` でほかのアプリの版から写す
5. 各ツールの `warnings` と `skipped` を、利用者に伝える

画面でしかできないこと（審査用のアカウント・App のプライバシー・画面写真）が残っていれば、App Store Connect の画面で入れてもらう。

## 初めて出すアプリの設定

初めて App Store に出すアプリは、2 のほかに、次のものを入れる。どれも、同じ呼び出しをやり直してよい。

1. `set_app_info` で、カテゴリ・コンテンツ配信権・年齢制限の答えを入れる。返る `appStoreAgeRating` が、App Store が決めた年齢
2. `set_price` で、価格を入れる（いまは無料だけ）
3. `set_availability` で、配信する国を入れる。ほかのアプリと同じ国にするなら、`sameAsApp` を使う
4. `copy_review_contact` で、審査の連絡先を、ほかのアプリの版から写す

価格と配信する国は、呼ぶたびに利用者の確認が出る。呼ぶ前に、入れる値を利用者に見せる。

次のものは API に無いので、[App Store Connect](https://appstoreconnect.apple.com/apps) でアプリを開き、画面で入れてもらう。

- 「App のプライバシー」
- Apple シリコン搭載の Mac と Apple Vision Pro での配信。「価格および配信状況」のページの、「Appleシリコン搭載のMacでのiPhoneおよびiPad用のアプリ」と「Apple Vision Pro上のiPhoneおよびiPadアプリ」の「配信可能にする」で決める。iPhone だけに出すときは、2 つとも外してもらう。Claude からは読めないので、外したかを利用者に確かめる

## 3. 審査に出す

1. 利用者に、版の番号・ビルドの番号・公開のしかた・段階的リリースの有無・変えた文（新機能の文は全文）を見せる
2. 利用者がよいと言ったら、`submit_for_review` を呼ぶ
3. 出したあとは、`get_release_status` で状態を見る。審査の結果が出るまで、数時間から数日かかる

## 4. 公開する

- `AFTER_APPROVAL` と `SCHEDULED` の版は、審査が通れば、何もしなくても公開される
- `MANUAL` の版は、審査が通ると `PENDING_DEVELOPER_RELEASE` になる。利用者が公開してよいと言ったら、`release_version` を呼ぶ。公開は取り消せない
- 段階的リリースは、7日かけて少しずつ出す。`set_phased_release` で、止める（`pause`）・再開する（`resume`）・全員に出す（`complete`）。全員に出すのは取り消せない

## 却下されたとき・取り下げるとき

- 却下の理由は、App Store Connect の画面（Resolution Center）で読んでもらう。API では読めない
- 直したら、2 の手順で版を整え、3 でもう一度出す
- 審査に出した版を直したいときは、`cancel_review` で取り下げる。取り下げた版は、また編集できる
