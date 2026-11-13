import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { UserRow } from "./UserRow";
import { INVITE_MAX, type BattleCandidate, type BattleMember, type BattleReadyMember } from "./battle";

// オンライン対戦の画面（ソラチャットの画面の中に出る。拡張機能の枠の外）。見た目だけを持つ部品。
// 処理（相手探し・招待・準備OK・開始）は、呼び出し側（battleSession.tsx）が行う。

const SHEET_CLASS = "sheet-backdrop confirm-backdrop battle-backdrop";

export function BattleMatchingSheet({ size, onCancel }: { size: number; onCancel: () => void }) {
  return (
    <div className={SHEET_CLASS}>
      <div className="sheet confirm-sheet battle-sheet" role="dialog" aria-modal="true" aria-label="対戦相手を探しています">
        <div className="battle-spinner" aria-hidden="true" />
        <strong className="confirm-title">対戦相手を探しています</strong>
        <p className="confirm-text">同じ拡張機能で遊ぶ人が {size} 人そろうと、準備OKの確認に進みます。</p>
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            探すのをやめる
          </button>
        </div>
      </div>
    </div>
  );
}

const STATE_TEXT: Record<BattleCandidate["state"], string> = {
  online: "オンライン",
  offline: "オフライン",
  busy: "対戦中"
};

// 対戦の相手を選ぶ画面（ウィンドウ風のモーダル）。押したらすぐ出し、一覧は読み込めたら入れる。
// この拡張機能を持っている友だちだけを出し、オンラインの人にはマークを付ける。
export function BattlePickerPage({
  mode,
  candidates,
  error,
  onPick,
  onClose
}: {
  mode: "find" | "invite";
  // null のあいだは読み込み中（アニメーションを出す）
  candidates: BattleCandidate[] | null;
  error: string;
  // ランダムに探す（find のときだけ）・友だちを招待（ids）・やめる（null）
  onPick: (choice: { random: true } | { ids: string[] } | null) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);

  const toggle = (candidate: BattleCandidate) => {
    if (candidate.state === "busy") return;
    setPicked((list) => {
      if (list.includes(candidate.id)) return list.filter((id) => id !== candidate.id);
      if (list.length >= INVITE_MAX) return list;
      return [...list, candidate.id];
    });
  };

  const title = mode === "find" ? "対戦相手を選ぶ" : "対戦に招待する友だち";

  return (
    <div className="sheet-backdrop battle-backdrop battle-picker-backdrop" onClick={onClose}>
      <div
        className="sheet battle-picker-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="battle-picker-head">
          <strong>{title}</strong>
          <button type="button" className="battle-picker-close" onClick={onClose} aria-label="閉じる">
            <Icon name="close" size={18} />
          </button>
        </header>

        {mode === "find" && (
          <button type="button" className="battle-random" onClick={() => onPick({ random: true })}>
            <span className="battle-random-icon" aria-hidden="true">
              ?
            </span>
            <span className="row-text">
              <strong>ランダムに探す</strong>
              <small>同じ拡張機能で遊ぶ人と、自動で組みます</small>
            </span>
          </button>
        )}

        <div className="battle-picker-body">
          {candidates === null ? (
            <div className="battle-loading" role="status" aria-live="polite">
              <div className="battle-spinner" aria-hidden="true" />
              <p>友だちを読み込んでいます…</p>
            </div>
          ) : candidates.length === 0 ? (
            <p className="muted center pad">この拡張機能を持っていて、サブスクに入っている友だちがいません。</p>
          ) : (
            <>
              <p className="battle-picker-head-note muted small">友だちを選んでください（最大{INVITE_MAX}人）</p>
              <ul className="user-list-ul">
                {candidates.map((f, i) => (
                  <UserRow
                    key={f.id}
                    index={i}
                    userId={f.id}
                    hasAvatar={f.hasAvatar}
                    name={f.displayName}
                    sub={`@${f.username}`}
                    right={<span className={`battle-state is-${f.state}`}>{STATE_TEXT[f.state]}</span>}
                    check={{ checked: picked.includes(f.id), disabled: f.state === "busy" }}
                    onClick={() => toggle(f)}
                  />
                ))}
              </ul>
              <p className="muted small battle-picker-note">オフラインの友だちにも、端末に招待の通知が届きます。</p>
            </>
          )}
        </div>

        {error && <p className="notice center error shake battle-picker-error">{error}</p>}
        <div className="battle-picker-actions">
          <span className="muted small">{picked.length} / {INVITE_MAX} 人</span>
          <button
            type="button"
            className="btn-primary"
            disabled={candidates === null || picked.length === 0}
            onClick={() => onPick({ ids: picked })}
          >
            招待する
          </button>
        </div>
      </div>
    </div>
  );
}

// 招待したあと、承諾を待つ・開始するための画面（主催者）
export function BattleLobbySheet({
  members,
  busy,
  error,
  onStart,
  onLeave
}: {
  members: BattleMember[];
  busy: boolean;
  error: string;
  onStart: () => void;
  onLeave: () => void;
}) {
  const joined = members.filter((m) => m.state === "joined").length;
  return (
    <div className={SHEET_CLASS}>
      <div className="sheet confirm-sheet battle-sheet" role="dialog" aria-modal="true" aria-label="友だちとの対戦">
        <strong className="confirm-title">友だちを招待しました</strong>
        <p className="confirm-text">承諾した人が2人以上になると、「開始する」を押せます。開始したあとは、全員の準備OKで始まります。</p>
        <ul className="battle-members">
          {members.map((m, i) => (
            <li key={`${m.name}-${i}`} className={`battle-member is-${m.state}`}>
              <span className="battle-member-name">{m.name}</span>
              <span className="battle-member-state">{m.state === "joined" ? "参加" : "承諾待ち"}</span>
            </li>
          ))}
        </ul>
        {error && <p className="notice error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onLeave}>
            やめる
          </button>
          <button type="button" className="btn-primary" disabled={busy || joined < 2} onClick={onStart}>
            {busy ? "…" : "開始する"}
          </button>
        </div>
      </div>
    </div>
  );
}

// 準備OKの画面。参加者全員のアイコン・名前・準備OKかを出す。全員がそろうと「開始中」を2秒出してから始まる。
export function BattleReadySheet({
  members,
  readyUntil,
  ready,
  starting,
  busy,
  error,
  onReady,
  onLeave
}: {
  members: BattleReadyMember[];
  readyUntil: number;
  ready: boolean;
  starting: boolean;
  busy: boolean;
  error: string;
  onReady: () => void;
  onLeave: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((readyUntil - now) / 1000));
  return (
    <div className={SHEET_CLASS}>
      <div className="sheet confirm-sheet battle-sheet battle-ready-sheet" role="dialog" aria-modal="true" aria-label="準備OKを押してください">
        {starting ? (
          <>
            <strong className="confirm-title">全員の準備ができました</strong>
            <p className="battle-starting" role="status" aria-live="polite">
              開始中
              <span className="battle-dots" aria-hidden="true">
                <i>.</i>
                <i>.</i>
                <i>.</i>
              </span>
            </p>
          </>
        ) : (
          <>
            <strong className="confirm-title">対戦の準備ができました</strong>
            <p className="confirm-text">全員が「準備OK」を押すと、対戦が始まります。</p>
            <p className="battle-countdown">残り {left} 秒</p>
          </>
        )}
        <ul className="battle-people">
          {members.map((m) => (
            <li key={`${m.seat}-${m.name}`} className={`battle-person ${m.ready ? "is-ready" : "is-waiting"}`}>
              <Avatar userId={m.userId} hasAvatar={m.hasAvatar} name={m.name} size={40} />
              <span className="battle-person-name">{m.name}</span>
              <span className="battle-member-state">{m.ready ? "準備OK" : "準備中"}</span>
            </li>
          ))}
        </ul>
        {error && <p className="notice error">{error}</p>}
        {!starting && (
          <div className="confirm-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={onLeave}>
              やめる
            </button>
            <button type="button" className="btn-primary" disabled={busy || ready} onClick={onReady}>
              {busy ? "…" : ready ? "準備OKです" : "準備OK"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function BattleWaitingSheet({ hostName, busy, onLeave }: { hostName: string; busy: boolean; onLeave: () => void }) {
  return (
    <div className={SHEET_CLASS}>
      <div className="sheet confirm-sheet battle-sheet" role="dialog" aria-modal="true" aria-label="対戦の開始を待っています">
        <div className="battle-spinner" aria-hidden="true" />
        <strong className="confirm-title">対戦の開始を待っています</strong>
        <p className="confirm-text">{hostName ? `${hostName}さんが始めるまで待ってください。` : "主催者が始めるまで待ってください。"}</p>
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onLeave}>
            抜ける
          </button>
        </div>
      </div>
    </div>
  );
}

// 招待が届いたときの画面（ソラチャットを開いている間は、どの画面にも重ねて出す）
export function BattleInviteSheet({
  hostName,
  gameName,
  busy,
  error,
  onAccept,
  onDecline
}: {
  hostName: string;
  gameName: string;
  busy: boolean;
  error: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className={SHEET_CLASS}>
      <div className="sheet confirm-sheet battle-sheet" role="alertdialog" aria-modal="true" aria-label="招待が来ています">
        <strong className="confirm-title">招待が来ています</strong>
        <p className="confirm-text">
          {hostName}さんから「{gameName}」の対戦に招待されています。
        </p>
        {error && <p className="notice error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onDecline}>
            断る
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={onAccept}>
            {busy ? "…" : "参加する"}
          </button>
        </div>
      </div>
    </div>
  );
}
