import { useEffect, useMemo, useState } from "react";
import { ApiError, api, post } from "./api";
import { BUILTIN_STAMPS, canonicalStampRef } from "./stamps";

// 管理者パネルの「ストア・Pay」タブ
//   ・SenninPay の店舗（一覧・停止・再開）
//   ・仙人ストアのラインナップ（名前・説明・価格・スタンプの中身・販売の有無、スタンプパックの追加）

type Sub = "merchants" | "lineup";

type MerchantRow = { id: string; name: string; description: string; status: string; ownerName: string; createdAt: string };
type LineupRow = {
  id: string;
  kind: string;
  name: string;
  description: string;
  price: number;
  stamps: string[];
  feature: string | null;
  enabled: boolean;
  custom: boolean;
};
type Limits = { nameMax: number; descriptionMax: number; priceMax: number; stampsMax: number };
type LineupResponse = { items: LineupRow[]; operatorConfigured: boolean; limits: Limits };

const KIND: Record<string, string> = { stamp_pack: "スタンプ", theme: "外観", extension: "拡張機能" };
const errorOf = (e: unknown) => (e instanceof ApiError ? e.message : "通信に失敗しました。");

async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) window.dispatchEvent(new Event("admin-expired"));
    throw err;
  }
}

export function AdminPayPanel() {
  const [sub, setSub] = useState<Sub>("merchants");
  return (
    <div className="admin-studio">
      <div className="admin-segment" role="tablist">
        <button role="tab" aria-selected={sub === "merchants"} className={sub === "merchants" ? "on" : ""} onClick={() => setSub("merchants")}>
          店舗（Pay）
        </button>
        <button role="tab" aria-selected={sub === "lineup"} className={sub === "lineup" ? "on" : ""} onClick={() => setSub("lineup")}>
          ストアの商品
        </button>
      </div>
      {sub === "merchants" ? <MerchantsSection /> : <LineupSection />}
    </div>
  );
}

// ---- 店舗 ----

function MerchantsSection() {
  const [rows, setRows] = useState<MerchantRow[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    setError("");
    adminApi<{ merchants: MerchantRow[] }>("/api/admin/merchants")
      .then((data) => setRows(data.merchants))
      .catch((err) => setError(errorOf(err)));
  };

  useEffect(load, []);

  const toggle = async (row: MerchantRow) => {
    const next = row.status === "active" ? "suspended" : "active";
    setBusyId(row.id);
    setError("");
    try {
      await adminApi(`/api/admin/merchants/${row.id}/status`, post({ status: next }));
      load();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusyId(null);
    }
  };

  if (error && !rows) return <p className="cws-error">{error}</p>;
  if (!rows) return <p className="admin-empty">読み込み中…</p>;
  if (rows.length === 0) return <p className="admin-empty">まだ店舗はありません。</p>;

  return (
    <div className="admin-list">
      {error && <p className="cws-error">{error}</p>}
      {rows.map((row) => (
        <div key={row.id} className="admin-row">
          <div>
            <strong>{row.name}</strong>
            <div className="admin-sub">
              {row.ownerName} ・ {row.status === "active" ? "受付中" : "停止中"}
            </div>
            {row.description && <div className="admin-sub">{row.description}</div>}
          </div>
          <button type="button" className="btn-secondary" disabled={busyId === row.id} onClick={() => void toggle(row)}>
            {row.status === "active" ? "停止する" : "再開する"}
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- ストアの商品 ----

function LineupSection() {
  const [data, setData] = useState<LineupResponse | null>(null);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    setError("");
    adminApi<LineupResponse>("/api/admin/store/lineup")
      .then(setData)
      .catch((err) => setError(errorOf(err)));
  };

  useEffect(load, []);

  if (error && !data) return <p className="cws-error">{error}</p>;
  if (!data) return <p className="admin-empty">読み込み中…</p>;

  const editing = data.items.find((item) => item.id === editingId) ?? null;

  return (
    <div className="admin-lineup">
      {!data.operatorConfigured && (
        <p className="cws-error">
          運営のアカウント（OPERATOR_USER_ID）が未設定です。設定されるまで、自分の作品は買えず、運営へのポイント返却も保留になります。
        </p>
      )}
      {error && <p className="cws-error">{error}</p>}

      {!creating && !editing && (
        <button type="button" className="cws-primary" onClick={() => setCreating(true)}>
          スタンプパックを追加
        </button>
      )}

      {creating && (
        <PackEditor
          limits={data.limits}
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}

      {editing && (
        <ItemEditor
          key={editing.id}
          item={editing}
          limits={data.limits}
          onCancel={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            load();
          }}
        />
      )}

      {!editing && (
        <div className="admin-list">
          {data.items.map((item) => (
            <div key={item.id} className="admin-row">
              <div>
                <strong>{item.name}</strong>
                <div className="admin-sub">
                  {KIND[item.kind] ?? item.kind} ・ {item.price === 0 ? "無料" : `${item.price.toLocaleString("ja-JP")} pt`}
                  {item.kind === "stamp_pack" && ` ・ スタンプ${item.stamps.length}種`}
                  {item.custom && " ・ 運営追加"}
                  {" ・ "}
                  {item.enabled ? "販売中" : "販売停止"}
                </div>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setEditingId(item.id)}>
                編集
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// スタンプの選択（組み込みのスタンプだけ）
function StampPicker({ value, max, onChange }: { value: string[]; max: number; onChange: (next: string[]) => void }) {
  const selected = useMemo(() => new Set(value.map(canonicalStampRef)), [value]);
  const toggle = (ref: string) => {
    const key = canonicalStampRef(ref);
    if (selected.has(key)) {
      onChange(value.filter((x) => canonicalStampRef(x) !== key));
    } else if (value.length < max) {
      onChange([...value, ref]);
    }
  };
  return (
    <div className="admin-stamp-grid" role="group" aria-label="スタンプの選択">
      {BUILTIN_STAMPS.map((stamp) => {
        const on = selected.has(canonicalStampRef(stamp.ref));
        return (
          <button
            key={stamp.ref}
            type="button"
            className={`admin-stamp${on ? " is-on" : ""}`}
            aria-pressed={on}
            onClick={() => toggle(stamp.ref)}
            title={stamp.name}
          >
            <img src={stamp.url} alt="" width={48} height={48} />
            <span>{stamp.name}</span>
          </button>
        );
      })}
      <p className="admin-sub">選んだ数：{selected.size}（最大{max}）</p>
    </div>
  );
}

function ItemEditor({
  item,
  limits,
  onCancel,
  onSaved
}: {
  item: LineupRow;
  limits: Limits;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [price, setPrice] = useState(String(item.price));
  const [enabled, setEnabled] = useState(item.enabled);
  const [stamps, setStamps] = useState<string[]>(item.stamps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = {
      name,
      description,
      price: Number(price),
      enabled
    };
    if (item.kind === "stamp_pack") body.stamps = stamps;
    try {
      await adminApi(`/api/admin/store/items/${encodeURIComponent(item.id)}`, post(body));
      onSaved();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-editor">
      <strong>{item.name} を編集</strong>
      <label className="admin-field">
        <span>名前（{limits.nameMax}文字まで）</span>
        <input value={name} maxLength={limits.nameMax} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="admin-field">
        <span>説明（{limits.descriptionMax}文字まで）</span>
        <textarea value={description} maxLength={limits.descriptionMax} rows={2} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="admin-field">
        <span>価格（pt・0で無料）</span>
        <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <label className="admin-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        販売する（オフにすると、新しくは買えなくなります。買った人は引き続き使えます）
      </label>
      {item.kind === "stamp_pack" && (
        <div className="admin-field">
          <span>スタンプの中身</span>
          <StampPicker value={stamps} max={limits.stampsMax} onChange={setStamps} />
          <p className="admin-sub">
            ここから外したスタンプは、すべての人が送れるようになります。追加したスタンプは、買っていない人には送れなくなります。
          </p>
        </div>
      )}
      {error && <p className="cws-error">{error}</p>}
      <div className="admin-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          やめる
        </button>
        <button type="button" className="cws-primary" onClick={() => void save()} disabled={busy}>
          {busy ? "保存しています…" : "保存"}
        </button>
      </div>
    </div>
  );
}

function PackEditor({ limits, onCancel, onSaved }: { limits: Limits; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("300");
  const [stamps, setStamps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await adminApi("/api/admin/store/packs", post({ name, description, price: Number(price), stamps }));
      onSaved();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-editor">
      <strong>スタンプパックを追加</strong>
      <label className="admin-field">
        <span>名前（{limits.nameMax}文字まで）</span>
        <input value={name} maxLength={limits.nameMax} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="admin-field">
        <span>説明（{limits.descriptionMax}文字まで）</span>
        <textarea value={description} maxLength={limits.descriptionMax} rows={2} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="admin-field">
        <span>価格（pt・0で無料）</span>
        <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <div className="admin-field">
        <span>スタンプの中身</span>
        <StampPicker value={stamps} max={limits.stampsMax} onChange={setStamps} />
      </div>
      {error && <p className="cws-error">{error}</p>}
      <div className="admin-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          やめる
        </button>
        <button type="button" className="cws-primary" onClick={() => void save()} disabled={busy || !name.trim() || stamps.length === 0}>
          {busy ? "追加しています…" : "追加"}
        </button>
      </div>
    </div>
  );
}
