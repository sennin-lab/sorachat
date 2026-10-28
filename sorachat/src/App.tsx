import { useEffect, useState } from "react";
import { api } from "./api";
import { AuthScreen } from "./AuthScreen";
import { clearCache } from "./cache";
import { Home } from "./Home";
import type { Me } from "./types";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [authError] = useState(() => new URLSearchParams(window.location.search).get("auth_error"));

  useEffect(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) return <div className="boot">読み込み中…</div>;
  if (!me) return <AuthScreen initialError={authError} />;

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
