# yugi-dict

[yaml-yugi](https://github.com/DawnbrandBots/yaml-yugi) の日本語カード名から、Microsoft IME用のユーザー辞書を自動生成します。

日本語入力を有効にしたまま、`@`に続けてカード名の読みを入力すると、二重山括弧で囲んだ正式名称へ変換できます。

```text
＠ぶらっくまじしゃん → 《ブラック・マジシャン》
＠てんさうざんどどらごん → 《万物創世龍》
＠りとる → 《Ｓ：Ｐリトルナイト》（予測候補）
```

読みの先頭は、日本語入力中に`@`キーを押したときの全角文字`＠`です。カード名中の空白・中点などの装飾記号は読みから除き、英数字は全角の表記を保ちます。正式な読みのほか、区切りやルビから通常表記へ切り替わる位置を開始点とした検索用の別名も登録します。

## ダウンロードと登録

最新の辞書は [GitHub Releases](https://github.com/yuki-yano/yugi-dict/releases/latest) からダウンロードできます。

- `yugi-dict-msime.txt`: Microsoft IME用
- `yugi-dict-atok.txt`: ATOK用

### Microsoft IME

1. Microsoft IMEの設定から「学習と辞書」→「ユーザー辞書ツール」を開く
2. 「ツール」→「テキスト ファイルからの登録」を選ぶ
3. ダウンロードした `yugi-dict-msime.txt` を指定する

辞書はMicrosoft IME Dictionary ToolのWORDLIST形式で、UTF-16LE（BOM付き）・CRLFとして生成されます。

Microsoft IMEの「予測入力」が有効なら、読みを最後まで入力する前でも前方一致の予測候補から選択できます。通常のSpace変換は登録した読みとの完全一致です。

### ATOK for Mac

ATOK辞書ユーティリティで「ツール」→「ファイルから登録・削除」を開き、`yugi-dict-atok.txt`を指定します。同じファイルに対して［登録］を選ぶと一括登録、［削除］を選ぶと一括削除できます。削除は元に戻せないため、対象の辞書を確認してから実行してください。

ATOK形式の読みは32文字以内という制約があるため、これを超える読みだけ先頭32文字に短縮します。短縮件数は `manifest.json` の `atokTruncatedReadings` に記録します。

## 自動生成

GitHub Actionsは次のタイミングでyaml-yugiの`master`を取得し、辞書を生成します。

- `main`へのpush
- 毎日 03:00 JST（前日の18:00 UTC）の定期実行
- Actions画面からの手動実行
- pull request（artifact生成のみ）

生成時に使用したyaml-yugiのcommit、収録件数、辞書ファイルのSHA-256は `manifest.json` に記録します。CIは単体テストに加え、全件を対象に文字コード・改行・接頭辞・括弧・重複・ハッシュを検証します。

ローカルで生成する場合はNode.js 24、pnpm 11.20.0、Gitが必要です。

```sh
source_dir="$(mktemp -d)/yaml-yugi"
./scripts/fetch-yaml-yugi.sh "$source_dir"
source_ref="$(git -C "$source_dir" rev-parse HEAD)"
pnpm exec tsx src/generate.ts \
  --input "$source_dir/data/cards" \
  --msime-output dist/yugi-dict-msime.txt \
  --atok-output dist/yugi-dict-atok.txt \
  --manifest dist/manifest.json \
  --source-ref "$source_ref"
pnpm exec tsx scripts/verify-dist.ts dist
```

## データについて

カード情報の出典と権利に関する注記は [NOTICE.md](NOTICE.md) を参照してください。
