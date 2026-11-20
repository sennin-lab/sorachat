import { useCallback, useEffect, useState } from "react";
import { ApiError, api, put } from "./api";

// 管理者パネルの「銀行」タブ（SenninBank の管理）
//   ・一時停止・再開（止めている間は、預け入れ・引き出し・投資・配当の操作を受け付けない）
//   ・利率（日利・配当率の下限と上限）。空欄にすると、環境変数の値に戻る
//   ・銀行の状況（口座数・預金・利息・投資・配当の合計）と、最近の出来事

type Rates = { dailyPercent: number; dividendPercent: number; dividendMaxPercent: number };
type Stats = { accounts: number; principal: number; interest: number; invested: number; dividends: number; pendingOps: number };
type EventRow = { id: string; kind: string; amount: number; userName: string; creatorName: string | null; createdAt: string };
type BankAdminState = {
  ok: true;
  paused: boolean;
  rates: Rates;
  overrides: { dailyPercent: number | null; dividendPercent: number | null; dividendMaxPercent: number | null };
  envDefaults: Rates;
  stats: Stats;
  events: EventRow[];
};

const KIND_TEXT: Record<string, string> = { deposit: "預け入れ", withdraw: "引き出し", invest: "投資", divest: "投資の引き出し", dividend: "配当" };
const errorOf = (e: unknown) => (e instanceof ApiError ? e.message : "通信に失敗しました。");
const fmt = (n: number) => n.toLocaleString("ja-JP");
const pct = (n: number) => `${Number(n.toFixed(4))}%`;

async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) window.dispatchEvent(new Event("admin-expired"));
    throw err;
  }
}

export function AdminBankPanel() {
  const [state, setState] = useState<BankAdminState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  // 入力欄（文字のまま持つ。空欄は「環境変数の値を使う」）
  const [paused, setPaused] = useState(false);
  const [daily, setDaily] = useState("");
  const [dividend, setDividend] = useState("");
  const [dividendMax, setDividendMax] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await adminApi<BankAdminState>("/api/admin/bank");
      setState(data);
      setPaused(data.paused);
      setDaily(data.overrides.dailyPercent === null ? "" : String(data.overrides.dailyPercent));
      setDividend(data.overrides.dividendPercent === null ? "" : String(data.overrides.dividendPercent));
      setDividendMax(data.overrides.dividendMaxPercent === null ? "" : String(data.overrides.dividendMaxPercent));
      setError("");
    } catch (err) {
      setError(errorOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    const toNum = (s: string) => (s.trim() === "" ? null : Number(s));
    try {
      await adminApi("/api/admin/bank/settings", put({
        paused,
        dailyPercent: toNum(daily),
        dividendPercent: toNum(dividend),
        dividendMaxPercent: toNum(dividendMax)
      }));
      setNotice(paused ? "銀行を一時停止しました。" : "設定を保存しました。次の操作から反映されます。");
      await load();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setSaving(false);
    }
  };

  const resetRates = async () => {
    if (!window.confirm("利率を環境変数の値に戻します。よろしいですか？")) return;
    setDaily("");
    setDividend("");
    setDividendMax("");
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await adminApi("/api/admin/bank/settings", put({ paused, dailyPercent: null, dividendPercent: null, dividendMaxPercent: null }));
      setNotice("利率を既定の値に戻しました。");
      await load();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setSaving(false);
    }
  };

  if (!state) return <div className="boot">{error ? error : "銀行の情報を読み込み中…"}</div>;

  const s = state.stats;
  return (
    <section className="admin-stack">
      <section className="admin-card">
        <h2>SenninBank の状況</h2>
        <p className="muted">
          {state.paused ? "現在：一時停止中（預け入れ・引き出し・投資は止まっています）" : "現在：営業中"}
        </p>
        <dl className="admin-stats" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", margin: "12px 0" }}>
          <div><dt className="muted small">口座数</dt><dd>{fmt(s.accounts)}</dd></div>
          <div><dt className="muted small">預金の合計</dt><dd>{fmt(s.principal)} pt</dd></div>
          <div><dt className="muted small">利息の合計（確定分と未確定分）</dt><dd>{fmt(s.interest)} pt</dd></div>
          <div><dt className="muted small">投資の合計</dt><dd>{fmt(s.invested)} pt</dd></div>
          <div><dt className="muted small">配当の合計（これまで）</dt><dd>{fmt(s.dividends)} pt</dd></div>
          <div><dt className="muted small">途中の操作（確認中）</dt><dd>{fmt(s.pendingOps)} 件</dd></div>
        </dl>
        <button className="btn-secondary" onClick={() => void load()} disabled={saving}>更新</button>
      </section>

      <section className="admin-card">
        <h2>営業の停止</h2>
        <p className="muted">止めると、預け入れ・引き出し・投資・投資の引き出しを受け付けません。残高や利息の表示は続きます。</p>
        <label style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
          <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
          <strong>{paused ? "一時停止：オン" : "一時停止：オフ（営業中）"}</strong>
        </label>
      </section>

      <section className="admin-card">
        <h2>利率</h2>
        <p className="muted small">空欄にすると、環境変数の値を使います。</p>
        <label className="field-label" htmlFor="bank-daily">預金の利息（日利・%）</label>
        <input id="bank-daily" className="auth-input" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={`既定 ${pct(state.envDefaults.dailyPercent)}`} />
        <label className="field-label" htmlFor="bank-div">配当率の下限（%）</label>
        <input id="bank-div" className="auth-input" inputMode="decimal" value={dividend} onChange={(e) => setDividend(e.target.value)} placeholder={`既定 ${pct(state.envDefaults.dividendPercent)}`} />
        <label className="field-label" htmlFor="bank-div-max">配当率の上限（%）</label>
        <input id="bank-div-max" className="auth-input" inputMode="decimal" value={dividendMax} onChange={(e) => setDividendMax(e.target.value)} placeholder={`既定 ${pct(state.envDefaults.dividendMaxPercent)}`} />
        <p className="muted small">いま使われている値：日利 {pct(state.rates.dailyPercent)}・配当率 {pct(state.rates.dividendPercent)}〜{pct(state.rates.dividendMaxPercent)}。上限は下限以上にしてください。</p>
        {error && <p className="notice error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "設定を保存"}</button>
          <button className="btn-secondary" disabled={saving} onClick={() => void resetRates()}>利率を既定に戻す</button>
        </div>
      </section>

      <section className="admin-card">
        <h2>最近の出来事</h2>
        {state.events.length === 0 && <p className="muted">まだ出来事はありません。</p>}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {state.events.map((e) => (
            <li key={e.id} className="small" style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
              <span className="muted">{new Date(e.createdAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              {e.userName}　{KIND_TEXT[e.kind] ?? e.kind}　{fmt(e.amount)}pt
              {e.creatorName ? `（${e.creatorName}）` : ""}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
