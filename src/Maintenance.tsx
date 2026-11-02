import { useEffect } from "react";

// メンテナンス中の表示。サーバーの稼働状況を30秒ごとに確かめ、終わっていたら自動で読み直す
export function MaintenanceScreen({ message }: { message: string }) {
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        const data = (await res.json()) as { maintenance?: { enabled?: boolean } };
        if (!stopped && data.maintenance?.enabled === false) window.location.reload();
      } catch {
        // 確かめられなかったときは、次の回に確かめ直す
      }
    };
    const timer = window.setInterval(check, 30_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="maintenance">
      <div className="maintenance-card">
        <p className="maintenance-tag">メンテナンス中</p>
        <p className="maintenance-text">{message}</p>
        <button type="button" className="maintenance-reload" onClick={() => window.location.reload()}>
          再読み込み
        </button>
        <a className="maintenance-status" href="/status">
          サービスの稼働状況を見る
        </a>
      </div>
    </div>
  );
}
