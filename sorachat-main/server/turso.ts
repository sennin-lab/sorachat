import { config } from "./config.js";

// 画像・ファイルの中身を保存する Turso（libSQL）。HTTP API を fetch で直接呼ぶので、追加のパッケージは使わない。
// 保存先のテーブルは sc_blobs（path が主キー。path は Supabase の DB に入っている値と同じ）。
const ENDPOINT = `${config.tursoUrl.replace(/^libsql:\/\//, "https://").replace(/\/+$/, "")}/v2/pipeline`;

export type TursoArg =
  | { type: "text"; value: string }
  | { type: "integer"; value: string }
  | { type: "blob"; base64: string };

export type TursoValue =
  | { type: "null" }
  | { type: "text"; value: string }
  | { type: "integer"; value: string }
  | { type: "blob"; base64: string };

export async function tursoExecute(sql: string, args: TursoArg[] = []): Promise<TursoValue[][]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.tursoAuthToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql, args } },
        { type: "close" }
      ]
    })
  });
  const body = (await res.json().catch(() => null)) as {
    results?: { type: string; response?: { type: string; result?: { rows: TursoValue[][] } }; error?: { message?: string } }[];
    message?: string;
  } | null;
  if (!res.ok) throw new Error(`Turso の呼び出しに失敗しました（${res.status}）: ${body?.message ?? ""}`);
  const result = body?.results?.[0];
  if (!result || result.type !== "ok" || !result.response?.result) {
    throw new Error(`Turso の呼び出しに失敗しました: ${result?.error?.message ?? "不明なエラー"}`);
  }
  return result.response.result.rows;
}

// テーブルを作るのは、プロセスで最初に使うときに1回だけ（何度実行しても安全）
let schemaReady: Promise<void> | null = null;
export function ensureBlobTable(): Promise<void> {
  if (!schemaReady) {
    schemaReady = tursoExecute(
      `create table if not exists sc_blobs (
         path text primary key,
         content_type text not null,
         size integer not null,
         data blob not null,
         created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       )`
    ).then(() => undefined);
    // 失敗したら次の呼び出しでやり直す
    schemaReady.catch(() => {
      schemaReady = null;
    });
  }
  return schemaReady;
}
