import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api, post } from "./api";

type Mode = "choose" | "register" | "login";

export function AuthScreen({ initialError }: { initialError: string | null }) {
  const [mode, setMode] = useState<Mode>("choose");
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

  if (mode === "choose") {
    return (
      <div className="auth">
        <div className="auth-card">
          <h1>SoraChat</h1>
          <p className="lead">ひとりひとりとのDMを、静かに。</p>
          {error && <p className="error">{error}</p>}
          <a className="btn primary wide" href="/api/auth/sennin/login">
            仙人アカウントで続行
          </a>
          <button className="btn ghost wide" onClick={() => setMode("register")}>
            ユーザー名とパスワードで新規登録
          </button>
          <button className="link" onClick={() => setMode("login")}>
            ユーザー名とパスワードでログイン
          </button>
        </div>
      </div>
    );
  }

  const isRegister = mode === "register";

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <button type="button" className="link start" onClick={() => setMode("choose")}>
          ‹ 戻る
        </button>
        <h1>{isRegister ? "新規登録" : "ログイン"}</h1>
        {isRegister && (
          <label className="field">
            <span>表示名</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              autoComplete="nickname"
            />
          </label>
        )}
        <label className="field">
          <span>ユーザー名（英小文字・数字・_）</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            maxLength={20}
          />
        </label>
        <label className="field">
          <span>パスワード{isRegister ? "（8文字以上）" : ""}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? "new-password" : "current-password"}
            maxLength={72}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary wide" disabled={busy || !username || !password || (isRegister && !displayName)}>
          {isRegister ? "登録して始める" : "ログイン"}
        </button>
      </form>
    </div>
  );
}
