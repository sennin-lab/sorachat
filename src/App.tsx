import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { AuthScreen } from "./AuthScreen";
import { BannedScreen } from "./Banned";
import { clearCache } from "./cache";
import { Home } from "./Home";
import { Intro, hasSeenIntro, resetIntro } from "./Intro";
import { MaintenanceScreen } from "./Maintenance";
import type { BanInfo, Me } from "./types";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  // 利用停止中の内容（あれば、ほかの画面より先に利用停止の表示を出す）
  const [ban, setBan] = useState<BanInfo | null>(null);
  // メンテナンス中の文言（あれば、ほかの画面より先にメンテナンスの表示を出す）
  const [maintenance, setMaintenance] = useState<string | null>(null);
  const [authError] = useState(() => new URLSearchParams(window.location.search).get("auth_error"));
  // 初めて起動したときは、ウェルカムと機能紹介を出す（見終わると二度と自動では出ない）
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());

  const loadMe = useCallback(() => {
    api<Me>("/api/me")
      .then((data) => {
        setBan(null);
        setMe(data);
      })
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    loadMe();
    const onBanned = (event: Event) => setBan((event as CustomEvent<BanInfo>).detail);
    const onCheck = () => loadMe();
    const onMaintenance = (event: Event) =>
      setMaintenance((event as CustomEvent<string>).detail || "メンテナンス中ですしばらくお待ちください。");
    window.addEventListener("account-banned", onBanned);
    window.addEventListener("account-check", onCheck);
    window.addEventListener("maintenance", onMaintenance);
    return () => {
      window.removeEventListener("account-banned", onBanned);
      window.removeEventListener("account-check", onCheck);
      window.removeEventListener("maintenance", onMaintenance);
    };
  }, [loadMe]);

  if (maintenance) return <MaintenanceScreen message={maintenance} />;
  if (ban) return <BannedScreen ban={ban} onRecheck={loadMe} />;
  if (introOpen) return <Intro onDone={() => setIntroOpen(false)} />;
  if (me === undefined) return <div className="boot">読み込み中…</div>;
  if (!me)
    return (
      <AuthScreen
        initialError={authError}
        onShowIntro={() => {
          resetIntro();
          setIntroOpen(true);
        }}
      />
    );

  return (
    <Home
      me={me}
      onMeChange={(next) => setMe(next)}
      onLogout={() => {
        clearCache();
        setMe(null);
      }}
    />
  );
}
