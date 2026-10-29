import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api, post } from "./api";

type Mode = "start" | "register" | "login";

export function AuthScreen({ initialError }: { initialError: string | null }) {
  const [mode, setMode] = useState<Mode>("start");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialError) window.history.replaceState({}, "", "/");
  }, [initialError]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") {
        await api("/api/auth/register", post({ username, password, displayName }));
      } else {
        await api("/api/auth/login", post({ username, password }));
      }
      window.location.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "通信に失敗しました。");
      setBusy(false);
    }
  };

  if (mode === "start") {
    return (
      <div className="auth">
        <div className="auth-card">
          <h1 className="wordmark">SoraChat</h1>
          {error && <p className="notice error center">{error}</p>}
          <a className="btn-primary wide" href="/api/auth/sennin/login">
            仙人アカウントで続ける
          </a>
          <div className="divider">
            <span>または</span>
          </div>
          <button className="btn-secondary wide" onClick={() => setMode("login")}>
            ログイン
          </button>
          <button className="btn-secondary wide" onClick={() => setMode("register")}>
            新規登録
          </button>
        </div>
      </div>
    );
  }

  const isRegister = mode === "register";
  const ready = username && password && (!isRegister || displayName);

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="wordmark">SoraChat</h1>
        {isRegister && (
          <input
            className="auth-input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            placeholder="名前"
            autoComplete="nickname"
          />
        )}
        <input
          className="auth-input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          maxLength={20}
          placeholder="ユーザー名"
        />
        <input
          className="auth-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={isRegister ? "new-password" : "current-password"}
          maxLength={72}
          placeholder={isRegister ? "パスワード（8文字以上）" : "パスワード"}
        />
        {error && <p className="notice error center">{error}</p>}
        <button className="btn-primary wide" disabled={busy || !ready}>
          {isRegister ? "登録" : "ログイン"}
        </button>
        <button type="button" className="btn-text" onClick={() => setMode("start")}>
          戻る
        </button>
      </form>
    </div>
  );
}
