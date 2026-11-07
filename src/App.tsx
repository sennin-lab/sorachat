import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { AuthScreen } from "./AuthScreen";
import { BannedScreen } from "./Banned";
import { clearCache, loadMeDb, saveMeDb } from "./cache";
import { GroupCallHost } from "./GroupCallScreen";
import { Home } from "./Home";
import { Intro, hasSeenIntro, resetIntro } from "./Intro";
import { MaintenanceScreen } from "./Maintenance";
import type { BanInfo, Me } from "./types";
import { syncAvatars } from "./avatarCache";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  // 利用停止中の内容（あれば、ほかの画面より先に利用停止の表示を出す）
  const [ban, setBan] = useState<BanInfo | null>(null);
  // メンテナンス中の文言（あれば、ほかの画面より先にメンテナンスの表示を出す）
  const [maintenance, setMaintenance] = useState<string | null>(null);
  const [authError] = useState(() => new URLSearchParams(window.location.search).get("auth_error"));
  // 初めて起動したときは、ウェルカムと機能紹介を出す（見終わると二度と自動では出ない）
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());

  // 自分の情報は保存したものを先に表示し、サーバーで確かめ直す（ログインや利用停止の確認はサーバーで行う）
  const applyMe = useCallback((next: Me) => {
    setMe(next);
    saveMeDb(next);
    // 自分のアイコンは版が変わったときだけ取りに行く（保存済みならサーバーに問い合わせない）
    void syncAvatars([{ id: next.id, hasAvatar: next.hasAvatar, avatarVersion: next.avatarVersion }], { local: true });
  }, []);

  const loadMe = useCallback(() => {
    api<Me>("/api/me")
      .then((data) => {
        setBan(null);
        applyMe(data);
      })
      .catch((error) => {
        // 通信できないだけ・サーバーの一時的なエラーのときは、保存した情報のまま表示する（ログアウトにはしない）
        if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
          setMe((current) => current ?? null);
          return;
        }
        // ログインが切れている（401）ときだけ、ログイン画面に戻す
        setMe(null);
      });
  }, [applyMe]);

  useEffect(() => {
    void loadMeDb().then((cached) => {
      if (cached) setMe((current) => (current === undefined ? cached : current));
    });
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
    <>
      <Home
        me={me}
        onMeChange={(next) => applyMe(next)}
        onLogout={() => {
          clearCache();
          setMe(null);
        }}
      />
      <GroupCallHost me={me} />
    </>
  );
}
