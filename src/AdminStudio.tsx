import { useCallback, useEffect, useState } from "react";
import { ApiError, api, post } from "./api";

// 管理者パネルの「作品」タブ（senninstudio の審査・通報・作者の停止・支払いの再送）
// 作者ができない操作（公開停止・復帰・削除・作者の停止・支払いの再送）はここで行う

type Sub = "works" | "reports" | "payouts";

type WorkRow = {
  id: string;
  kind: string;
  name: string;
  price: number;
  status: string;
  hiddenReason: string | null;
  creatorName: string;
  reportCount: number;
  sales: number;
  createdAt: string;
};
type WorkDetail = {
  id: string;
  kind: string;
  name: string;
  description: string;
  price: number;
  status: string;
  hiddenReason: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  images: { id: string; role: string }[];
  creator: { id: string; name: string; suspended: boolean; suspendedReason: string | null };
  reports: { reporterName: string; reason: string; createdAt: string }[];
};
type ReportRow = { id: string; name: string; kind: string; status: string; hiddenReason: string | null; creatorName: string; reportCount: number; latestAt: string };
type PayoutRow = { id: string; creatorName: string; workName: string; amount: number; status: string; attempts: number; lastError: string | null; createdAt: string };

const KIND: Record<string, string> = { stamp_pack: "スタンプ", theme: "外観", quiz: "クイズ", ai_style: "応答スタイル", extension: "拡張機能" };
const STATUS: Record<string, string> = { published: "販売中", hidden: "非公開", deleted: "作者が削除", removed: "運営が削除" };
const REASON: Record<string, string> = { reports: "通報による自動非公開", admin: "運営が非公開", creator_suspended: "作者の停止" };
const when = (iso: string) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const errorOf = (e: unknown) => (e instanceof ApiError ? e.message : "通信に失敗しました。");

async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) window.dispatchEvent(new Event("admin-expired"));
    throw err;
  }
}

export function StudioPanel() {
  const [sub, setSub] = useState<Sub>("works");
  // 開いている作品（タブを行き来しても、詳細の表示を保つ）
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="admin-studio">
      <div className="admin-segment" role="tablist">
        <button role="tab" aria-selected={sub === "works"} className={sub === "works" ? "on" : ""} onClick={() => setSub("works")}>
          作品
        </button>
        <button role="tab" aria-selected={sub === "reports"} className={sub === "reports" ? "on" : ""} onClick={() => setSub("reports")}>
          通報
        </button>
        <button role="tab" aria-selected={sub === "payouts"} className={sub === "payouts" ? "on" : ""} onClick={() => setSub("payouts")}>
          支払い
        </button>
      </div>
      {sub === "works" && <WorksList openId={openId} onOpen={setOpenId} />}
      {sub === "reports" && (
        <ReportsList
          onOpen={(id) => {
            setOpenId(id);
            setSub("works");
          }}
        />
      )}
      {sub === "payouts" && <PayoutsList />}
    </div>
  );
}

function WorksList({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<WorkRow[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await adminApi<WorkRow[]>(`/api/admin/studio/works?status=${status}&q=${encodeURIComponent(q)}`));
      setError("");
    } catch (e) {
      setError(errorOf(e));
    }
  }, [status, q]);

  useEffect(() => {
    void load();
  }, [load]);

  if (openId) {
    return (
      <WorkDetailView
        id={openId}
        onBack={() => {
          onOpen(null);
          void load();
        }}
      />
    );
  }

  return (
    <>
      <div className="admin-toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状態で絞る">
          <option value="all">すべて</option>
          <option value="published">販売中</option>
          <option value="hidden">非公開</option>
          <option value="removed">運営が削除</option>
          <option value="deleted">作者が削除</option>
        </select>
        <input placeholder="作品名で検索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="作品名で検索" />
      </div>
      {error && <p className="notice error center">{error}</p>}
      <ul className="admin-list">
        {rows.map((w) => (
          <li key={w.id}>
            <button type="button" onClick={() => onOpen(w.id)}>
              <span className="admin-list-main">
                <strong>{w.name}</strong>
                <small>
                  {KIND[w.kind] ?? w.kind} ・ {w.price} pt ・ 作者 {w.creatorName} ・ 販売 {w.sales} 件
                </small>
              </span>
              <span className="admin-list-tag">
                {STATUS[w.status]}
                {w.reportCount > 0 && <em> 通報 {w.reportCount}</em>}
              </span>
            </button>
          </li>
        ))}
        {rows.length === 0 && !error && <li className="admin-empty">作品はありません。</li>}
      </ul>
    </>
  );
}

function WorkDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      setWork(await adminApi<WorkDetail>(`/api/admin/studio/works/${id}`));
    } catch (e) {
      setMessage({ ok: false, text: errorOf(e) });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await run();
      setMessage({ ok: true, text: `${label}しました。` });
      await load();
    } catch (e) {
      setMessage({ ok: false, text: errorOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: "published" | "hidden" | "removed", label: string) =>
    act(label, () => adminApi(`/api/admin/studio/works/${id}/status`, post({ status, reason: reason.trim() || undefined })));

  const suspend = (suspended: boolean) =>
    act(suspended ? "作者を停止" : "作者の停止を解除", () =>
      adminApi(`/api/admin/studio/creators/${work?.creator.id}/suspend`, post({ suspended, reason: reason.trim() || undefined }))
    );

  if (!work) {
    return (
      <div className="admin-detail">
        <button type="button" className="btn-small" onClick={onBack}>
          一覧へ戻る
        </button>
        {message && <p className="notice error center">{message.text}</p>}
      </div>
    );
  }

  const imageUrl = (imageId: string) => `/api/admin/studio/images/${imageId}`;
  return (
    <div className="admin-detail">
      <button type="button" className="btn-small" onClick={onBack}>
        一覧へ戻る
      </button>
      <h3 className="admin-title">{work.name}</h3>
      <p className="admin-meta">
        {KIND[work.kind]} ・ {work.price} pt ・ 作者 {work.creator.name} ・ {when(work.createdAt)}
      </p>
      <p className="admin-state">
        状態: {STATUS[work.status]}
        {work.hiddenReason && `（${REASON[work.hiddenReason] ?? work.hiddenReason}）`}
      </p>
      <p className="admin-desc">{work.description || "（説明なし）"}</p>

      <div className="admin-thumbs">
        {work.images.map((img) => (
          <img key={img.id} src={imageUrl(img.id)} alt="" className={img.role === "thumb" ? "is-thumb" : ""} loading="lazy" />
        ))}
      </div>

      {work.kind === "quiz" && Array.isArray((work.payload as { questions?: unknown })?.questions) && (
        <details className="admin-details">
          <summary>問題の中身</summary>
          <ol>
            {((work.payload as { questions: { q: string; options: string[]; answer: number }[] }).questions).map((q, i) => (
              <li key={i}>
                {q.q}（{q.options.map((o, oi) => (oi === q.answer ? `【${o}】` : o)).join(" / ")}）
              </li>
            ))}
          </ol>
        </details>
      )}

      <h4 className="admin-subtitle">通報（{work.reports.length}件）</h4>
      {work.reports.length === 0 ? (
        <p className="admin-empty">通報はありません。</p>
      ) : (
        <ul className="admin-plain">
          {work.reports.map((r, i) => (
            <li key={i}>
              {r.reporterName}・{when(r.createdAt)}{r.reason && `：${r.reason}`}
            </li>
          ))}
        </ul>
      )}

      <label className="admin-field">
        <span>理由（任意・作者や通報者には表示されません）</span>
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
      </label>

      <div className="admin-actions">
        {work.status !== "published" && work.status !== "removed" && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => setStatus("published", "公開に戻し")}>
            公開に戻す
          </button>
        )}
        {work.status === "published" && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setStatus("hidden", "非公開にし")}>
            非公開にする
          </button>
        )}
        {work.status !== "removed" && (
          <button type="button" className="btn-small danger" disabled={busy} onClick={() => setStatus("removed", "削除し")}>
            運営として削除する
          </button>
        )}
        {work.reports.length > 0 && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => act("通報の記録を消し", () => adminApi(`/api/admin/studio/works/${id}/dismiss-reports`, post()))}
          >
            通報を消す
          </button>
        )}
      </div>

      <div className="admin-actions">
        {work.creator.suspended ? (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => suspend(false)}>
            この作者の停止を解除
          </button>
        ) : (
          <button type="button" className="btn-small danger" disabled={busy} onClick={() => suspend(true)}>
            この作者を停止する
          </button>
        )}
      </div>
      {work.creator.suspended && <p className="admin-state">作者は停止中です。{work.creator.suspendedReason && `（${work.creator.suspendedReason}）`}</p>}

      {message && <p className={`notice center ${message.ok ? "" : "error"}`}>{message.text}</p>}
    </div>
  );
}

function ReportsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    adminApi<ReportRow[]>("/api/admin/studio/reports")
      .then(setRows)
      .catch((e) => setError(errorOf(e)));
  }, []);
  return (
    <>
      {error && <p className="notice error center">{error}</p>}
      <ul className="admin-list">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r.id)}>
              <span className="admin-list-main">
                <strong>{r.name}</strong>
                <small>
                  作者 {r.creatorName} ・ 最新の通報 {when(r.latestAt)}
                </small>
              </span>
              <span className="admin-list-tag">
                通報 {r.reportCount}
                <em> {STATUS[r.status]}</em>
              </span>
            </button>
          </li>
        ))}
        {rows.length === 0 && !error && <li className="admin-empty">通報はありません。</li>}
      </ul>
    </>
  );
}

function PayoutsList() {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState<PayoutRow[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await adminApi<PayoutRow[]>(`/api/admin/studio/payouts?status=${status}`));
    } catch (e) {
      setMessage({ ok: false, text: errorOf(e) });
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (id: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      await adminApi(`/api/admin/studio/payouts/${id}/retry`, post());
      setMessage({ ok: true, text: "支払いを行いました。" });
    } catch (e) {
      setMessage({ ok: false, text: errorOf(e) });
    } finally {
      setBusyId(null);
      void load();
    }
  };

  return (
    <>
      <div className="admin-toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状態で絞る">
          <option value="pending">保留中</option>
          <option value="failed">失敗</option>
          <option value="paid">支払い済み</option>
        </select>
      </div>
      {message && <p className={`notice center ${message.ok ? "" : "error"}`}>{message.text}</p>}
      <ul className="admin-list">
        {rows.map((p) => (
          <li key={p.id} className="admin-payout">
            <span className="admin-list-main">
              <strong>
                {p.amount} pt ・ {p.creatorName}
              </strong>
              <small>
                作品 {p.workName} ・ {when(p.createdAt)} ・ 試行 {p.attempts} 回
              </small>
              {p.lastError && <small className="admin-error">{p.lastError}</small>}
            </span>
            {p.status !== "paid" && (
              <button type="button" className="btn-small accent" disabled={busyId !== null} onClick={() => void retry(p.id)}>
                {busyId === p.id ? "処理中…" : "再送"}
              </button>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="admin-empty">該当する支払いはありません。</li>}
      </ul>
    </>
  );
}
