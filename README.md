# LingoQuest (Cloudflare Pages + AI proxy)

```
public/index.html          アプリ本体（AI呼び出しは /api/chat へ）
functions/api/chat.js      Anthropic APIの中継 + IPごとのレート制限
wrangler.toml              KV（RATE_LIMIT）と制限値の設定
tests/chat.test.mjs        中継とレート制限のテスト（npm test）
```

## 1. 初回セットアップ（ローカル）
```
npm install
npx wrangler login
npx wrangler kv namespace create RATE_LIMIT
```
表示された `id` を `wrangler.toml` の `id` と `preview_id` に貼り付けます。

## 2. ローカルテスト（GitHubへ push する前）
```
cp .dev.vars.example .dev.vars     # GROQ_API_KEY を自分のキーに書き換え
npm test                           # 中継・制限のテスト（APIキー不要）
npm run dev                        # http://localhost:8788 で動作確認
```
制限の確認: `curl -X POST localhost:8788/api/chat -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'` を4回続けて送ると、
4回目が429（分あたり3回の制限）になります。ブラウザでも、上限を超えるとエラー表示に「本日の利用上限に達しました」が出ます。
`.dev.vars` は `.gitignore` 済みです。キーをコミットしないでください。

## 3. Cloudflareダッシュボードの設定
1. Workers & Pages → 対象のPagesプロジェクト → **Settings → Variables and Secrets**
2. **Add** → Type: **Secret**、Name: `GROQ_API_KEY`、Value: 自分のキー → Production と Preview の両方に登録
3. （任意）`DAILY_LIMIT` / `MINUTE_LIMIT` を変更する場合は、同じ画面で Text として登録するか、`wrangler.toml` の `[vars]` を編集
4. KV は `wrangler.toml` に書いてあるため、ダッシュボードでの追加は不要です（`wrangler.toml` がある場合は、そこが設定の正になります）

デプロイ: GitHubリポジトリをPagesに接続（ビルドコマンドなし、出力ディレクトリ `public`）、または `npm run deploy`。

## 仕様メモ
- 制限はIP単位（`CF-Connecting-IP`）。既定は1日5回・1分3回。1日はUTC基準（日本時間の午前9時にリセット）。
- このアプリはチャット1往復ごとに1回AIを呼ぶため、1日5回は少なめです。実際に使うときは `DAILY_LIMIT` を増やしてください（例: 100）。
- KVのカウントは厳密ではありません（同時アクセスが多いと少しずれます）。厳密にするならDurable Objectsを使います。
- 同じ学校のWi-Fiなど、同じIPの人は1つの枠を共有します。
- `stream: true` を付けると、Anthropicのストリーミング応答をそのまま返します。アプリ自体は完成したJSONが必要なため、通常は使いません。
- 進捗は各自のブラウザにだけ保存されます（クラウド保存と利用統計は claude.ai 上でのみ動きます）。

## AIプロバイダー
`GROQ_API_KEY` があればGroq（既定モデル `llama-3.3-70b-versatile`）、なければ `ANTHROPIC_API_KEY` でAnthropicを使います。両方ある場合は `AI_PROVIDER`（`groq` / `anthropic`）で選べます。モデルは `MODEL` で変更できます（利用できるモデル名はGroqの最新の一覧で確認してください）。
