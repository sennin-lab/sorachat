import { useEffect, useState } from "react";
import { api } from "./api";
import { AuthScreen } from "./AuthScreen";
import { clearCache } from "./cache";
import { Home } from "./Home";
import { Intro, hasSeenIntro, resetIntro } from "./Intro";
import type { Me } from "./types";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [authError] = useState(() => new URLSearchParams(window.location.search).get("auth_error"));
  // 初めて起動したときは、ウェルカムと機能紹介を出す（見終わると二度と自動では出ない）
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());

  useEffect(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

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
