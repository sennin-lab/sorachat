import { useCallback, useEffect, useState } from "react";
import { ApiError, api, post } from "./api";

// 管理者パネルの「宝くじ」タブ
//   ・宝くじを作る（名前・桁数・何等まで・各等の賞金・結果発表日）。1券は 1000pt
//   ・結果発表日になったら、「結果を発表する」で当選番号を引く。番号は一桁ずつ公開され、全部見せ終わると当選者が出る

type Winner = { tier: number; number: string; prize: number; name: string; userId: string; status: string };
type Lottery = {
  id: string;
  name: string;
  ticketPrice: number;
  digits: number;
  prizes: { tier: number; pt: number }[];
  announceOn: string;
  status: "selling" | "revealing" | "done";
  canAnnounce: boolean;
  revealed: string;
  finishesAt: string | null;
  winningNumber: string | null;
  winners: Winner[] | null;
  sold: number;
  pendingPayouts: number;
};
type ListResponse = {
  ok: true;
  today: string;
  limits: { digits: [number, number]; tiers: number; maxPrize: number; nameMax: number; ticketPrice: number };
  lotteries: Lottery[];
};

const errorOf = (e: unknown) => (e instanceof ApiError ? e.message : "通信に失敗しました。");
const STATUS_TEXT: Record<Lottery["status"], string> = { selling: "販売中", revealing: "公開中", done: "結果確定" };
const fmt = (n: number) => n.toLocaleString("ja-JP");

async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) window.dispatchEvent(new Event("admin-expired"));
    throw err;
  }
}

export function AdminLotteryPanel() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // 作成フォーム
  const [name, setName] = useState("");
  const [digits, setDigits] = useState(4);
  const [tiers, setTiers] = useState(3);
  const [prizes, setPrizes] = useState<string[]>(["10000", "1000", "100"]);
  const [announceOn, setAnnounceOn] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await adminApi<ListResponse>("/api/admin/lotteries"));
      setError("");
    } catch (err) {
      setError(errorOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 公開の途中は、画面の数字を進めるために定期的に読み直す
  const revealing = data?.lotteries.some((l) => l.status === "revealing") ?? false;
  useEffect(() => {
    if (!revealing) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [revealing, load]);

  // 等の数を変えたら、賞金の欄の数を合わせる
  const changeTiers = (next: number) => {
    setTiers(next);
    setPrizes((prev) => Array.from({ length: next }, (_, i) => prev[i] ?? ""));
  };
  const changeDigits = (next: number) => {
    setDigits(next);
    if (tiers > next) changeTiers(next);
  };

  const create = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await adminApi("/api/admin/lotteries", post({
        name,
        digits,
        prizes: prizes.map((p) => Number(p)),
        announceOn
      }));
      setNotice("宝くじを作りました。販売を始めます。");
      setName("");
      setPrizes(Array.from({ length: tiers }, () => ""));
      setAnnounceOn("");
      await load();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  const announce = async (lottery: Lottery) => {
    if (!window.confirm(`「${lottery.name}」の結果を発表します。販売はここで終わります。よろしいですか？`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await adminApi(`/api/admin/lotteries/${lottery.id}/announce`, post());
      setNotice(`「${lottery.name}」の結果を発表しました。番号は一桁ずつ公開されます。`);
      await load();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="boot">{error ? error : "宝くじの情報を読み込み中…"}</div>;

  const [minDigits, maxDigits] = data.limits.digits;
  const tierMax = Math.min(digits, data.limits.tiers);

  return (
    <section className="admin-stack">
      <section className="admin-card">
        <h2>宝くじを作る</h2>
        <p className="muted">1券 {fmt(data.limits.ticketPrice)}pt。結果発表日（日本時間）になったら、一覧から発表できます。</p>

        <label className="field-label" htmlFor="lot-name">宝くじ名（{data.limits.nameMax}文字まで）</label>
        <input id="lot-name" className="auth-input" maxLength={data.limits.nameMax} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：秋の大感謝くじ" />

        <label className="field-label" htmlFor="lot-digits">当選番号の桁数</label>
        <select id="lot-digits" className="auth-input" value={digits} onChange={(e) => changeDigits(Number(e.target.value))}>
          {Array.from({ length: maxDigits - minDigits + 1 }, (_, i) => minDigits + i).map((d) => (
            <option key={d} value={d}>{d}桁</option>
          ))}
        </select>

        <label className="field-label" htmlFor="lot-tiers">何等まで</label>
        <select id="lot-tiers" className="auth-input" value={tiers} onChange={(e) => changeTiers(Number(e.target.value))}>
          {Array.from({ length: tierMax }, (_, i) => i + 1).map((t) => (
            <option key={t} value={t}>{t}等まで</option>
          ))}
        </select>

        <label className="field-label" htmlFor="lot-prize-1">最高金額（1等・pt）</label>
        <input id="lot-prize-1" className="auth-input" inputMode="numeric" value={prizes[0] ?? ""} onChange={(e) => setPrizes((p) => [e.target.value, ...p.slice(1)])} placeholder="例：10000" />

        {Array.from({ length: tiers - 1 }, (_, i) => i + 2).map((t) => (
          <div key={t}>
            <label className="field-label" htmlFor={`lot-prize-${t}`}>{t}等の賞金（pt）</label>
            <input
              id={`lot-prize-${t}`}
              className="auth-input"
              inputMode="numeric"
              value={prizes[t - 1] ?? ""}
              onChange={(e) => setPrizes((p) => p.map((v, i) => (i === t - 1 ? e.target.value : v)))}
            />
          </div>
        ))}
        <p className="muted small">下の等ほど少ない額にしてください。{digits}桁の場合、1等は全桁一致、2等は末尾{digits - 1}桁一致…と、下の等ほど当たりやすくなります。</p>

        <label className="field-label" htmlFor="lot-announce">結果発表日</label>
        <input id="lot-announce" className="auth-input" type="date" min={data.today} value={announceOn} onChange={(e) => setAnnounceOn(e.target.value)} />

        {error && <p className="notice error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
        <button className="btn-primary" disabled={busy || !name.trim() || !announceOn || prizes.some((p) => p.trim() === "")} onClick={() => void create()}>
          {busy ? "作成中…" : "宝くじを作る"}
        </button>
      </section>

      <section className="admin-card">
        <div className="admin-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>宝くじの一覧</h2>
          <button className="btn-secondary" onClick={() => void load()} disabled={busy}>更新</button>
        </div>
        {data.lotteries.length === 0 && <p className="muted">まだ宝くじはありません。</p>}
        {data.lotteries.map((l) => (
          <article key={l.id} className="admin-lottery-item" style={{ borderTop: "1px solid var(--line)", padding: "14px 0" }}>
            <p><strong>{l.name}</strong>　<span className="muted small">{STATUS_TEXT[l.status]}</span></p>
            <p className="muted small">
              {l.digits}桁・1券 {fmt(l.ticketPrice)}pt・販売 {fmt(l.sold)}枚・結果発表日 {l.announceOn}
            </p>
            <p className="small">
              {l.prizes.map((p) => `${p.tier}等 ${fmt(p.pt)}pt`).join(" / ")}
            </p>

            {l.status === "selling" && (
              <>
                <button className="btn-primary" disabled={busy || !l.canAnnounce} onClick={() => void announce(l)}>
                  結果を発表する
                </button>
                {!l.canAnnounce && l.sold === 0 && <p className="muted small">券が1枚も売れていないため、発表できません。</p>}
                {!l.canAnnounce && l.sold > 0 && <p className="muted small">結果発表日（{l.announceOn}）になると発表できます。</p>}
              </>
            )}

            {(l.status === "revealing" || l.status === "done") && (
              <div className="lot-admin-result" style={{ margin: "10px 0" }}>
                <p className="small muted">当選番号（公開済み）</p>
                <p style={{ fontSize: 24, fontWeight: 700, letterSpacing: "0.2em", fontVariantNumeric: "tabular-nums" }}>
                  {Array.from({ length: l.digits }, (_, i) => l.revealed[i] ?? "・").join(" ")}
                </p>
              </div>
            )}

            {l.status === "done" && l.winners && (
              <>
                <p className="small">
                  当選 {fmt(l.winners.length)}枚・未払い {fmt(l.pendingPayouts)}件
                  {l.pendingPayouts > 0 && "（仙人アカウントの連携や、ポイントの上限を確かめてください。次の機会に自動で再試行します）"}
                </p>
                {l.winners.length > 0 && (
                  <ul className="admin-winners" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {l.winners.map((w, i) => (
                      <li key={`${w.userId}-${w.number}-${i}`} className="small" style={{ padding: "4px 0" }}>
                        {w.tier}等　{w.number}　{w.name}　{fmt(w.prize)}pt　<span className="muted">{w.status === "paid" ? "払い出し済" : "未払い"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </article>
        ))}
      </section>
    </section>
  );
}
