import { Fragment, useState } from "react";
import { createPortal } from "react-dom";
import { clipLongWords } from "./clip";
import { ConfirmDialog } from "./ConfirmDialog";
import { MentionText } from "./MentionText";

// 本文の http:// / https:// のURLを青い文字のリンクにする。
// 押すと「安全性が確認されていません。開きますか？」と聞き、「はい」で新しいタブに開く。
// URL は表示のために切らない（clipLongWords の対象外）。URL以外の文字は従来どおり扱う。
const SPLIT = /(https?:\/\/[^\s<>"'`「」『』【】]+)/gi;
// URL の末尾に付いた句読点や閉じ括弧は、リンクに含めない
const TRAILING = /[.,;:!?、。，．！？)）\]】」』>]+$/;
const MIN_URL_LENGTH = 12;

const splitTrailing = (raw: string) => {
  const tail = raw.match(TRAILING)?.[0] ?? "";
  return { url: raw.slice(0, raw.length - tail.length), tail };
};

function LinkButton({ url }: { url: string }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      {/* href を付けない。長押しや中クリックで確認を通らずに開かれないようにするため */}
      <button
        type="button"
        className="msg-link"
        onClick={(e) => {
          // 確認を出す（吹き出しのダブルタップ判定にも渡さない）
          e.stopPropagation();
          setAsking(true);
        }}
      >
        {url}
      </button>
      {asking &&
        createPortal(
          // 確認は吹き出しの外（body 直下）に出す。ボタンのクリックが吹き出しへ伝わらないように止める
          <div onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
            <ConfirmDialog
              title="リンクを開きますか"
              message="このリンクは安全性が確認されていません。開きますか？"
              confirmLabel="はい"
              onCancel={() => setAsking(false)}
              onConfirm={() => {
                setAsking(false);
                window.open(url, "_blank", "noopener,noreferrer");
              }}
            />
          </div>,
          document.body
        )}
    </>
  );
}

export function RichText({ text, users, meName }: { text: string; users: Set<string>; meName: string }) {
  // split の結果は「文字・URL・文字・URL…」の順。奇数番目が URL
  const parts = text.split(SPLIT);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) {
          return <MentionText key={i} text={clipLongWords(part)} users={users} meName={meName} />;
        }
        const { url, tail } = splitTrailing(part);
        if (url.length < MIN_URL_LENGTH) {
          return <MentionText key={i} text={clipLongWords(part)} users={users} meName={meName} />;
        }
        return (
          <Fragment key={i}>
            <LinkButton url={url} />
            {tail && <MentionText text={tail} users={users} meName={meName} />}
          </Fragment>
        );
      })}
    </>
  );
}
