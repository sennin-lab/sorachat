import { useCallback, useEffect, useState } from "react";

// サービス稼働状況のページ（/status）。表示する値はサーバーが実際に行った確認の結果だけです。
type State = "ok" | "degraded" | "down" | "unconfigured" | "unchecked" | "maintenance";
type Overall = "ok" | "degraded" | "down" | "maintenance";

type Check = {
  label: string;
  state: State;
  latencyMs: number | null;
  detail: string;
  optional: boolean;
};

type Feature = {
  id: string;
  group: string;
  name: string;
  state: State;
  note: string | null;
  checks: Check[];
};

type Report = {
  service: string;
  checkedAt: string;
  cacheSeconds: number;
  uptimeSeconds: number;
  maintenance: { enabled: boolean; message: string };
  overall: Overall;
  features: Feature[];
};

const STATE_LABEL: Record<State, string> = {
  ok: "正常",
  degraded: "一部不調",
  down: "停止中",
  unconfigured: "未設定",
  unchecked: "未確認",
  maintenance: "メンテナンス中"
};

const OVERALL_LABEL: Record<Overall, string> = {
  ok: "確認できた範囲では、問題はありません",
  degraded: "一部に不具合があります",
  down: "一部の機能が停止しています",
  maintenance: "メンテナンス中です"
};

const REFRESH_MS = 30_000;

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}日 ${hours}時間 ${minutes}分`;
  if (hours > 0) return `${hours}時間 ${minutes}分`;
  return `${minutes}分`;
}

function StateBadge({ state }: { state: State }) {
  return <span className={`status-badge st-${state}`}>{STATE_LABEL[state]}</span>;
}

export function StatusPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);

  // 画面の見た目は、チャットで選んだテーマに合わせる（保存されていなければライト）
  useEffect(() => {
    try {
      document.documentElement.dataset.theme = localStorage.getItem("sorachat-theme") === "dark" ? "dark" : "light";
    } catch {
      document.documentElement.dataset.theme = "light";
    }
  }, []);

  const load = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport((await res.json()) as Report);
      setFailed(false);
    } catch {
      // 取れなかったときは、最後に取れた結果を残したまま「取得できなかった」と出す
      setFailed(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const groups = report ? [...new Set(report.features.map((f) => f.group))] : [];

  return (
    <div className="status-page">
      <header className="status-head">
        <a className="status-back" href="/">
          チャットへ戻る
        </a>
        <h1>SoraChat の稼働状況</h1>
      </header>

      {failed && (
        <div className="status-alert" role="alert">
          稼働状況を取得できませんでした。サーバーに接続できない可能性があります。
          {report ? "（下の表示は、最後に取得できた結果です）" : ""}
        </div>
      )}

      {!report && !failed && <p className="status-loading">確認しています…</p>}

      {report && (
        <>
          <section className={`status-overall st-${report.overall}`}>
            <p className="status-overall-label">{OVERALL_LABEL[report.overall]}</p>
            {report.maintenance.enabled && <p className="status-maintenance-message">{report.maintenance.message}</p>}
            <p className="status-meta">最終確認: {formatTime(report.checkedAt)}（{report.cacheSeconds}秒の間は同じ結果を表示します）</p>
            <p className="status-meta">サーバーの起動から {formatUptime(report.uptimeSeconds)}</p>
            <button type="button" className="status-refresh" onClick={() => void load()} disabled={checking}>
              {checking ? "確認中…" : "今すぐ確認"}
            </button>
          </section>

          {groups.map((group) => (
            <section key={group} className="status-group">
              <h2>{group}</h2>
              {report.features
                .filter((f) => f.group === group)
                .map((feature) => (
                  <article key={feature.id} className="status-feature">
                    <div className="status-feature-head">
                      <h3>{feature.name}</h3>
                      <StateBadge state={feature.state} />
                    </div>
                    {feature.note && <p className="status-note">{feature.note}</p>}
                    <ul className="status-checks">
                      {feature.checks.map((check, index) => (
                        <li key={`${feature.id}-${index}`} className="status-check">
                          <div className="status-check-head">
                            <span className="status-check-label">
                              {check.label}
                              {check.optional && <span className="status-optional">（任意）</span>}
                            </span>
                            <StateBadge state={check.state} />
                          </div>
                          <p className="status-detail">
                            {check.detail}
                            {check.latencyMs !== null && `（${check.latencyMs} ms）`}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
            </section>
          ))}

          <section className="status-legend">
            <h2>表示の見方</h2>
            <ul>
              <li>
                <StateBadge state="ok" />：確認に成功しました。
              </li>
              <li>
                <StateBadge state="degraded" />：エラーが返った、または任意の部分が使えません。
              </li>
              <li>
                <StateBadge state="down" />：確認に失敗しました（応答がない、または時間切れ）。
              </li>
              <li>
                <StateBadge state="unconfigured" />：必要な設定がないため、使えません。
              </li>
              <li>
                <StateBadge state="unchecked" />：設定の有無は分かりますが、この画面では実際の接続を試していません。
              </li>
              <li>
                <StateBadge state="maintenance" />：メンテナンス中のため、利用者向けの機能は止めています。
              </li>
            </ul>
            <p>（任意）は、その機能の一部で、使えなくても機能そのものは続けられるものです。</p>
          </section>
        </>
      )}
    </div>
  );
}
