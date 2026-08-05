# yugi-dict

[yaml-yugi](https://github.com/DawnbrandBots/yaml-yugi) の日本語カード名から、Microsoft IME用のユーザー辞書を自動生成します。

日本語入力を有効にしたまま、`@`に続けてカード名の読みを入力すると、二重山括弧で囲んだ正式名称へ変換できます。

```text
＠ぶらっくまじしゃん → 《ブラック・マジシャン》
＠てんさうざんどどらごん → 《万物創世龍》
```

読みの先頭は、日本語入力中に`@`キーを押したときの全角文字`＠`です。カード名中の空白・中点などの装飾記号は読みから除き、英数字は全角の表記を保ちます。

## ダウンロードと登録

最新の `yugi-dict-msime.txt` は [GitHub Releases](https://github.com/yuki-yano/yugi-dict/releases/latest) からダウンロードできます。

1. Microsoft IMEの設定から「学習と辞書」→「ユーザー辞書ツール」を開く
2. 「ツール」→「テキスト ファイルからの登録」を選ぶ
3. ダウンロードした `yugi-dict-msime.txt` を指定する

辞書はMicrosoft IME Dictionary ToolのWORDLIST形式で、UTF-16LE（BOM付き）・CRLFとして生成されます。

## 自動生成

GitHub Actionsは次のタイミングでyaml-yugiの`master`を取得し、辞書を生成します。

- `main`へのpush
- 毎日 03:17 UTC の定期実行
- Actions画面からの手動実行
- pull request（artifact生成のみ）

生成時に使用したyaml-yugiのcommit、収録件数、辞書ファイルのSHA-256は `manifest.json` に記録します。CIは単体テストに加え、全件を対象に文字コード・改行・接頭辞・括弧・重複・ハッシュを検証します。

ローカルで生成する場合はNode.js 24とGitが必要です。

```sh
source_dir="$(mktemp -d)/yaml-yugi"
./scripts/fetch-yaml-yugi.sh "$source_dir"
source_ref="$(git -C "$source_dir" rev-parse HEAD)"
npx tsx src/generate.ts \
  --input "$source_dir/data/cards" \
  --output dist/yugi-dict-msime.txt \
  --manifest dist/manifest.json \
  --source-ref "$source_ref"
npx tsx scripts/verify-dist.ts dist
```

## データについて

カード情報の出典と権利に関する注記は [NOTICE.md](NOTICE.md) を参照してください。
