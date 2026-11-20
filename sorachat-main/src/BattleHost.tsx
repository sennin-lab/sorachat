import { useEffect, useState } from "react";
import { ApiError } from "./api";
import { battleApi } from "./battle";
import { BattleInviteSheet } from "./BattleSheets";
import { BattleSubscribeSheet } from "./BattleSubscription";
import { ExtensionRunner } from "./ExtensionRunner";
import { onBattleEvent } from "./realtime";
import type { Me } from "./types";

// 対戦の招待を、どの画面からでも受け取る（ソラチャットの全体に重ねて出す）。
// 承諾すると、その拡張機能を開いて、同じ部屋で開始を待つ。サブスクがなければ、先に案内を出す。

type Invite = { roomId: string; gameId: string; gameName: string; hostName: string };
type Joining = { roomId: string; workId: string; name: string };

export function BattleHost({ me }: { me: Me }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [joining, setJoining] = useState<Joining | null>(null);
  const [needSub, setNeedSub] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    return onBattleEvent((ev) => {
      if (ev.type === "battle-invite") {
        setInvites((list) =>
          list.some((i) => i.roomId === ev.roomId)
            ? list
            : [...list, { roomId: ev.roomId, gameId: ev.gameId, gameName: ev.gameName, hostName: ev.hostName }]
        );
        return;
      }
      // 招待の期限が過ぎた・主催者が始めた（自分は選ばれなかった）ときは、招待を消す
      if (ev.event === "invite_closed" || ev.event === "closed") {
        setInvites((list) => list.filter((i) => i.roomId !== ev.roomId));
      }
    });
  }, [me.id]);

  const current = invites[0] ?? null;

  const dismiss = (roomId: string) => setInvites((list) => list.filter((i) => i.roomId !== roomId));

  const accept = async (invite: Invite) => {
    setBusy(true);
    setError("");
    try {
      await battleApi.roomAction(invite.roomId, "accept");
      dismiss(invite.roomId);
      setJoining({ roomId: invite.roomId, workId: invite.gameId, name: invite.gameName });
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_subscribed") {
        setNeedSub(invite);
      } else {
        setError(e instanceof Error ? e.message : "参加できませんでした。");
      }
    } finally {
      setBusy(false);
    }
  };

  const decline = async (invite: Invite) => {
    setBusy(true);
    setError("");
    try {
      await battleApi.roomAction(invite.roomId, "decline");
    } catch {
      // 断るのが届かなくても、招待は画面から消す（期限で自然に終わる）
    } finally {
      setBusy(false);
      dismiss(invite.roomId);
    }
  };

  return (
    <>
      {current && !needSub && !joining && (
        <BattleInviteSheet
          hostName={current.hostName}
          gameName={current.gameName}
          busy={busy}
          error={error}
          onAccept={() => void accept(current)}
          onDecline={() => void decline(current)}
        />
      )}
      {needSub && (
        <BattleSubscribeSheet
          reason="友だちとの対戦は、サブスクに入っている人が使えます。"
          onSubscribed={() => {
            const invite = needSub;
            setNeedSub(null);
            void accept(invite);
          }}
          onClose={() => {
            const invite = needSub;
            setNeedSub(null);
            dismiss(invite.roomId);
          }}
        />
      )}
      {joining && (
        <ExtensionRunner
          key={joining.roomId}
          workId={joining.workId}
          name={joining.name}
          joinRoomId={joining.roomId}
          onClose={() => setJoining(null)}
        />
      )}
    </>
  );
}
