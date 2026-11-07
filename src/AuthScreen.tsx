import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, post } from "./api";
import { Icon } from "./Icon";
import { RobotFace } from "./robot";

type Mode = "start" | "register" | "login";

// サーバーと同じ条件（ユーザー名は前後の空白を消して小文字にしてから判定する）
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const PASSWORD_MIN = 8;

// 吹き出しのロゴ（トークの形をモチーフにしたもの）
function Logo({ size = 72 }: { size?: number }) {
  return (
    <div className="auth-logo" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 64 64" width={size * 0.62} height={size * 0.62}>
        <path d="M32 8C17.6 8 6 17.4 6 29c0 6.4 3.4 12.1 8.8 16L12 56l12.2-7.4c2.6.6 5.3.9 7.8.9 14.4 0 26-9.4 26-21S46.4 8 32 8z" />
        <circle cx="20" cy="29" r="3.6" />
        <circle cx="32" cy="29" r="3.6" />
        <circle cx="44" cy="29" r="3.6" />
      </svg>
    </div>
  );
}

// 入力欄の左に出す小さなアイコン（ユーザー・鍵）と、パスワードの表示切り替え
const UserGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </svg>
);
const LockGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
const EyeGlyph = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    {!open && <path d="M3 3l18 18" />}
  </svg>
);

function Field({
  icon,
  children,
  invalid
}: {
  icon: ReactNode;
  children: ReactNode;
  invalid?: boolean;
}) {
  return (
    <label className={`auth-field${invalid ? " invalid" : ""}`}>
      <span className="auth-field-icon">{icon}</span>
      {children}
    </label>
  );
}

export function AuthScreen({ initialError, onShowIntro }: { initialError: string | null; onShowIntro: () => void }) {
  const [mode, setMode] = useState<Mode>("start");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  const [errorKey, setErrorKey] = useState(0);
  const [busy, setBusy] = useState(false);
  // 仙人アカウントでログインできるか（サーバーの設定がある場合だけ、ボタンを出す）
  const [senninOn, setSenninOn] = useState(false);
  useEffect(() => {
    api<{ sennin: boolean }>("/api/auth/options")
      .then((data) => setSenninOn(Boolean(data.sennin)))
      .catch(() => setSenninOn(false));
  }, []);

  const isRegister = mode === "register";
  const normalizedName = username.trim().toLowerCase();
  const usernameInvalid = username.length > 0 && !USERNAME_RE.test(normalizedName);
  const passwordShort = isRegister && password.length > 0 && password.length < PASSWORD_MIN;
  const ready = normalizedName.length > 0 && password.length > 0 && (!isRegister || (displayName.trim().length > 0 && password.length >= PASSWORD_MIN && !usernameInvalid));

  const fail = (message: string) => {
    setError(message);
    setErrorKey((k) => k + 1);
    setBusy(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      if (isRegister) {
        await api("/api/auth/register", post({ username: normalizedName, password, displayName: displayName.trim() }));
      } else {
        await api("/api/auth/login", post({ username: normalizedName, password }));
      }
      window.location.replace("/");
    } catch (err) {
      fail(err instanceof ApiError ? err.message : "通信に失敗しました。");
    }
  };

  if (mode === "start") {
    return (
      <div className="auth auth-v2">
        <div className="auth-backdrop" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div className="auth-hero">
          <Logo />
          <h1 className="auth-title">SoraChat</h1>
          <p className="auth-tagline">話したい人と、つながる場所</p>
        </div>

        <div className="auth-panel">
          {error && (
            <p className="notice error center auth-error" key={errorKey}>
              {error}
            </p>
          )}
          {senninOn && (
          <a className="auth-sennin" href="/api/auth/sennin/login">
            <span className="auth-sennin-icon">
              <RobotFace />
            </span>
            <span className="auth-sennin-text">
              <strong>仙人アカウントで続ける</strong>
              <small>かんたんにはじめられます</small>
            </span>
            <Icon name="chevron" size={20} />
          </a>
          )}
          {senninOn && (
            <div className="divider">
              <span>または</span>
            </div>
          )}
          <button className="btn-primary wide auth-cta" onClick={() => setMode("login")}>
            ログイン
          </button>
          <button className="btn-secondary wide auth-cta" onClick={() => setMode("register")}>
            新規登録
          </button>
        </div>

        <button type="button" className="btn-text auth-intro-link" onClick={onShowIntro}>
          機能紹介を見る
        </button>
      </div>
    );
  }

  return (
    <div className="auth auth-v2 auth-form-screen">
      <div className="auth-backdrop" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <form className="auth-panel auth-form" key={mode} onSubmit={submit} noValidate>
        <button type="button" className="auth-back" onClick={() => setMode("start")} aria-label="戻る">
          <Icon name="back" size={22} />
        </button>

        <div className="auth-hero compact">
          <Logo size={56} />
          <h1 className="auth-form-title">{isRegister ? "新規登録" : "ログイン"}</h1>
          <p className="auth-tagline">{isRegister ? "アカウントを作って、トークをはじめましょう" : "ユーザー名とパスワードを入力してください"}</p>
        </div>

        {isRegister && (
          <Field icon={<UserGlyph />}>
            <input
              className="auth-field-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              placeholder="表示名（40文字まで）"
              autoComplete="nickname"
              autoFocus
            />
          </Field>
        )}

        <Field icon={<UserGlyph />} invalid={usernameInvalid}>
          <input
            className="auth-field-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
            maxLength={20}
            placeholder="ユーザー名"
            autoFocus={!isRegister}
          />
        </Field>
        {isRegister && (
          <p className={`auth-hint${usernameInvalid ? " bad" : ""}`}>英小文字・数字・_ の3〜20文字</p>
        )}

        <Field icon={<LockGlyph />} invalid={passwordShort}>
          <input
            className="auth-field-input"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? "new-password" : "current-password"}
            maxLength={72}
            placeholder={isRegister ? "パスワード（8文字以上）" : "パスワード"}
          />
          <button
            type="button"
            className="auth-eye"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"}
            aria-pressed={showPassword}
          >
            <EyeGlyph open={showPassword} />
          </button>
        </Field>
        {isRegister && (
          <p className={`auth-hint${passwordShort ? " bad" : password.length >= PASSWORD_MIN ? " good" : ""}`}>
            {password.length >= PASSWORD_MIN ? "パスワードの長さはOKです" : `あと${PASSWORD_MIN - password.length}文字以上入力してください`}
          </p>
        )}

        {error && (
          <p className="notice error center auth-error" key={errorKey}>
            {error}
          </p>
        )}

        <button className="btn-primary wide auth-cta auth-submit" disabled={busy || !ready}>
          {busy && <span className="auth-spinner" aria-hidden="true" />}
          {busy ? "送信中…" : isRegister ? "登録する" : "ログイン"}
        </button>

        <div className="auth-switch">
          {isRegister ? "すでにアカウントをお持ちですか？" : "アカウントをお持ちでないですか？"}
          <button type="button" className="btn-text" onClick={() => setMode(isRegister ? "login" : "register")}>
            {isRegister ? "ログイン" : "新規登録"}
          </button>
        </div>
      </form>
    </div>
  );
}
