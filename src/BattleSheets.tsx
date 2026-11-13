import type { BattleMember } from "./battle";

// オンライン対戦の画面（ソラチャットの画面の中に出る。拡張機能の枠の外）。見た目だけを持つ部品。
// 処理（相手探し・招待・開始）は、呼び出し側（拡張機能の画面・招待の受け取り）が行う。

const SHEET_CLASS = "sheet-backdrop confirm-backdrop battle-backdrop";

export function BattleMatchingSheet({ size, onCancel }: { size: number; onCancel: () => void }) {
  return (
    <div className={SHEET_CLASS}>
      <div className="sheet confirm-sheet battle-sheet" role="dialog" aria-modal="true" aria-label="対戦相手を探しています">
        <div className="battle-spinner" aria-hidden="true" />
        <strong className="confirm-title">対戦相手を探しています</strong>
        <p className="confirm-text">同じ拡張機能で遊ぶ人が {size} 人そろうと、すぐ始まります。</p>
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            探すのをやめる
          </button>
        </div>
      </div>
    </div>
  );
}

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
        <p className="confirm-text">承諾した人が2人以上になると、「開始する」を押せます。</p>
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
      <div className="sheet confirm-sheet battle-sheet" role="alertdialog" aria-modal="true" aria-label="対戦の招待">
        <strong className="confirm-title">対戦の招待</strong>
        <p className="confirm-text">
          {hostName}さんから「{gameName}」の対戦に招待されました。
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
