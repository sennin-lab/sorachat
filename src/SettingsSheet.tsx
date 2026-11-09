import { useEffect, useState } from "react";
import { ApiError, api, delete_, post } from "./api";
import { Icon } from "./Icon";
import { disablePush, enablePush, testPush } from "./push";
import { getShowUnsent, setShowUnsent } from "./prefs";
import { getLiquidIcon, setLiquidIcon } from "./iconPrefs";
import type { Me } from "./types";

// 設定（LINE の設定画面のように、項目をグループ分けして表示する）
export function SettingsSheet({
  me,
  theme,
  onThemeChange,
  onChange,
  onClose,
  onLogout
}: {
  me: Me;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onChange: (me: Me) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [notify, setNotify] = useState(me.notifyDm);
  const [ai, setAi] = useState(me.aiEnabled);
  const [showUnsent, setShowUnsentState] = useState(getShowUnsent);
  const [liquidIcon, setLiquidIconState] = useState(getLiquidIcon);
  const [status, setStatus] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // ブロックしている人の一覧（ここから解除できる）
  const [blockedList, setBlockedList] = useState<{ id: string; displayName: string }[]>([]);
  useEffect(() => {
    api<{ id: string; displayName: string }[]>("/api/blocks").then(setBlockedList).catch(() => undefined);
  }, []);
  const unblock = async (id: string) => {
    try {
      await api(`/api/blocks/${id}`, delete_());
      setBlockedList((list) => list.filter((u) => u.id !== id));
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "解除できませんでした。");
    }
  };

  // senninai（AIチャット）のオン・オフ。オンにするとトーク一覧に「senninai」が出る
  const toggleAi = async (on: boolean) => {
    setBusy(true);
    setStatus("");
    setAi(on);
    try {
      onChange(await api<Me>("/api/me", post({ aiEnabled: on })));
    } catch (err) {
      setAi(!on);
      setStatus(err instanceof ApiError ? err.message : "AI機能の設定を変更できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const toggleNotify = async (on: boolean) => {
    setBusy(true);
    setStatus("");
    setNotify(on);
    try {
      if (on) {
        // 許可の確認を先に出す（先に通信すると iOS で確認が出せなくなる）。失敗したら設定もオフのまま
        const result = await enablePush();
        if (!result.ok) {
          setNotify(false);
          setStatus(result.message);
          return;
        }
        onChange(await api<Me>("/api/me", post({ notifyDm: true })));
      } else {
        onChange(await api<Me>("/api/me", post({ notifyDm: false })));
        await disablePush();
      }
    } catch (err) {
      setNotify(!on);
      setStatus(err instanceof ApiError ? err.message : "通知の設定を変更できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  };

  return (
    <div className="page" role="dialog" aria-label="設定">
      <header className="page-bar">
        <button onClick={onClose} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <strong>設定</strong>
        <span />
      </header>

      <div className="section-label flush">
        <span>表示</span>
      </div>
      <div className="page-card">
        <label className="page-row">
          <span className="row-label">
            <span className="option-icon">
              <Icon name="moon" size={18} />
            </span>
            ダークモード
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={theme === "dark"}
            onChange={(e) => onThemeChange(e.target.checked ? "dark" : "light")}
          />
        </label>
        <label className="page-row">
          <span className="row-label">
            <span className="option-icon">
              <Icon name="image" size={18} />
            </span>
            Liquid Glass アイコン
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={liquidIcon}
            onChange={(e) => {
              setLiquidIcon(e.target.checked);
              setLiquidIconState(e.target.checked);
            }}
          />
        </label>
        <label className="page-row">
          <span className="row-label">
            <span className="option-icon">
              <Icon name="unsend" size={18} />
            </span>
            送信取り消しの表示
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={showUnsent}
            onChange={(e) => {
              setShowUnsent(e.target.checked);
              setShowUnsentState(e.target.checked);
            }}
          />
        </label>
      </div>
      <p className="notice center small">Liquid Glass アイコンをオフにすると通常アイコンに戻ります。初期設定は通常アイコンです。</p>
      <p className="notice center small">オフにすると、取り消されたメッセージはトークに表示されません（この端末の設定です）。</p>

      <div className="section-label flush">
        <span>AI</span>
      </div>
      <div className="page-card">
        <label className="page-row">
          <span className="row-label">
            <span className="option-icon">
              <Icon name="chat" size={18} />
            </span>
            senninai（AIチャット）
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={ai}
            disabled={busy}
            onChange={(e) => void toggleAi(e.target.checked)}
          />
        </label>
      </div>
      <p className="notice center small">
        オンにすると、トーク一覧に「senninai」が出ます。トークでは「太郎とのチャットを読んで要点を教えて」「太郎への返信を考えて」「太郎に『明日遅れます』と送って」（送る前に確認）などができます。
        グループでは「/senninai add」で参加し、「/senninai ask 質問」で質問できます（「太郎のことどう思う？」のように人について聞くことも）。
        話しかけた内容は、AIの応答のために外部サービス（UserLocal）へ送られます。オフにすると一覧から消えます。
      </p>

      <div className="section-label flush">
        <span>通知</span>
      </div>
      <div className="page-card">
        <label className="page-row">
          <span className="row-label">
            <span className="option-icon">
              <Icon name="bell" size={18} />
            </span>
            新着メッセージの通知
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={notify}
            disabled={busy}
            onChange={(e) => void toggleNotify(e.target.checked)}
          />
        </label>
      </div>

      {notify && (
        <div className="page-card">
          <button
            className="page-row"
            disabled={busy}
            onClick={async () => {
              setTestMessage("送信しています…");
              setTestMessage(await testPush());
            }}
          >
            <span>テスト通知を送る</span>
          </button>
        </div>
      )}
      {testMessage && <p className="notice center">{testMessage}</p>}

      <div className="section-label flush">
        <span>ブロック</span>
      </div>
      <div className="page-card">
        {blockedList.length === 0 && (
          <div className="page-row static">
            <span className="muted">ブロックしている人はいません</span>
          </div>
        )}
        {blockedList.map((u) => (
          <div key={u.id} className="page-row static">
            <span>{u.displayName}</span>
            <button className="btn-small" onClick={() => void unblock(u.id)}>
              解除
            </button>
          </div>
        ))}
      </div>

      <div className="section-label flush">
        <span>アカウント</span>
      </div>
      <div className="page-card">
        <button className="page-row danger" onClick={() => void logout()}>
          <span>ログアウト</span>
        </button>
      </div>

      {status && <p className="notice center error shake">{status}</p>}
    </div>
  );
}
