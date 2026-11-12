import { useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { Page } from "./Page";

// 友だち招待キャンペーン：自分の招待コード・リンク・招待の人数
type ReferralInfo = {
  enabled: boolean;
  code: string | null;
  points: number;
  invitedCount: number;
  rewardedCount: number;
};

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

export function ReferralSheet({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<ReferralInfo | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api<ReferralInfo>("/api/referral")
      .then(setInfo)
      .catch((err) => setError(messageOf(err)));
  }, []);

  const link = info?.code ? `${window.location.origin}/?invite=${info.code}` : "";

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label}をコピーしました。`);
    } catch {
      setNotice("コピーできませんでした。文字を選んでコピーしてください。");
    }
  };

  const share = async () => {
    if (!info?.code) return;
    const text = `ソラチャットに招待します。招待コード ${info.code} で登録すると、お互いに${info.points.toLocaleString("ja-JP")}ptもらえます。`;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "ソラチャット", text, url: link });
        return;
      } catch {
        // 共有をやめたときは何もしない
        return;
      }
    }
    await copy(link, "招待リンク");
  };

  return (
    <Page title="友だち招待" onBack={onClose}>
      {error && <p className="notice error center">{error}</p>}
      {!info && !error && <p className="muted center">読み込み中…</p>}
      {info && (
        <section className="referral-card">
          <p className="referral-lead">友だちを招待すると、お互いに</p>
          <p className="referral-points">
            {info.points.toLocaleString("ja-JP")}<span>pt</span>
          </p>
          <p className="referral-note">招待された人が招待コードを入れて登録すると、もらえます。</p>

          {!info.enabled ? (
            <p className="notice center">今は友だち招待キャンペーンを行っていません。</p>
          ) : (
            <>
              <div className="referral-code-label">あなたの招待コード</div>
              <div className="referral-code" aria-label="招待コード">
                {info.code}
              </div>
              <div className="referral-actions">
                <button className="btn-secondary" onClick={() => info.code && void copy(info.code, "招待コード")}>
                  コードをコピー
                </button>
                <button className="btn-primary" onClick={() => void copy(link, "招待リンク")}>
                  リンクをコピー
                </button>
              </div>
              <button className="btn-text referral-share" onClick={() => void share()}>
                共有する
              </button>
              {notice && <p className="referral-notice">{notice}</p>}
            </>
          )}

          <dl className="referral-stats">
            <div>
              <dt>招待した人</dt>
              <dd>{info.invitedCount}人</dd>
            </div>
            <div>
              <dt>報酬が付いた人</dt>
              <dd>{info.rewardedCount}人</dd>
            </div>
          </dl>
          <p className="referral-fine">
            同じ回線（IPアドレス）からの招待は対象外です。報酬は仙人アカウントのポイントに付きます（仙人アカウントとの連携が必要です）。
          </p>
        </section>
      )}
    </Page>
  );
}
