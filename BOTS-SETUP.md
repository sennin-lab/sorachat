# Bots（Groq無料AI）セットアップ

## 追加されたもの
- server/bots.ts ：/bots の配信、/api/bots/chat（Groqへの中継）、/api/bots/link（SoraChat連携の許可）
- server/index.ts ：bots ルーターの登録（1行）
- public/bots.html ：Bots の画面。SoraChat の画面からはリンクしていません
- supabase/schema_bots.sql ：連携の許可を保存する表

## 手順
1. Supabase の SQL Editor で supabase/schema_bots.sql を実行
2. Groq（https://console.groq.com）で無料のAPIキーを発行
3. 環境変数を設定
   - GROQ_API_KEY=gsk_...
   - GROQ_MODEL=llama-3.3-70b-versatile（任意。無料枠のモデル名が変わったら差し替え）
4. npm install && npm run build && npm start
5. https://（サーバー）/bots を開く（SoraChat にログインした状態で）

## 使い方
- 設定（スライダーのアイコン）→「SoraChat と連携」をオンにすると、Bots が SoraChat の情報（機能の要約）を使って答えます
- 連携はいつでもオフにできます。ユーザーのパスワードや他人のメッセージは AI に渡しません

## 注意
- 投資は、AIが実際のお金を自動で売買しない設計です。情報提供と一般的な注意に留めています
- 無料枠には利用上限があります。上限に達すると「AIが応答できませんでした」と表示されます
