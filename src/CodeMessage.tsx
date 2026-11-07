import { useLayoutEffect, useRef, useState } from "react";
import { RichText } from "./LinkText";

async function copyCode(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

// 表示だけ整える（元の文章・コピー・編集・送信はそのまま）。
// 改行が3つ以上続くと大きな空白になるので2つまでにし、前後の余計な空行は消す
const tidy = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");

// 長い文章は、先頭の10行だけ出して「全文を表示」で開く
const CLAMP_LINES = 10;

export function CodeMessage({ text, users, meName }: { text: string; users: Set<string>; meName: string }) {
  const [copied, setCopied] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clampRef = useRef<HTMLSpanElement>(null);
  const parts = text.split(/```([^\n`]*)\n([\s\S]*?)```/g);
  const plainOnly = parts.length === 1;
  const maybeLong = plainOnly && (text.length > 140 || text.split("\n").length > 6);

  // 実際に10行を超えて切れているときだけ「全文を表示」を出す
  useLayoutEffect(() => {
    if (!maybeLong || expanded) return;
    const measure = () => {
      const el = clampRef.current;
      if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [maybeLong, expanded, text]);

  if (plainOnly) {
    const body = <RichText text={tidy(text)} users={users} meName={meName} />;
    if (!maybeLong) return body;
    return (
      <>
        <span ref={clampRef} className={expanded ? undefined : "msg-clamp"}>
          {body}
        </span>
        {(overflowing || expanded) && (
          <button
            type="button"
            className="msg-more"
            onClick={(e) => {
              // 吹き出しのタップ（メニュー）に渡さない
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? "閉じる" : "全文を表示"}
          </button>
        )}
      </>
    );
  }
  const output = [];
  for (let i = 0; i < parts.length; ) {
    const plain = parts[i++].replace(/^\n+|\n+$/g, "");
    if (plain) output.push(<span key={`text-${i}`}><RichText text={plain} users={users} meName={meName} /></span>);
    if (i < parts.length) {
      const language = parts[i++] || "code";
      const code = parts[i++] ?? "";
      const index = output.length;
      output.push(
        <div className="ai-code-block" key={`code-${index}`} onClick={(e) => e.stopPropagation()}>
          <div className="ai-code-head">
            <span>{language.trim().slice(0, 24)}</span>
            <button type="button" onClick={async () => setCopied((await copyCode(code)) ? index : null)}>
              {copied === index ? "コピーしました" : "コードをコピー"}
            </button>
          </div>
          <pre><code>{code}</code></pre>
        </div>
      );
    }
  }
  return <div className="ai-code-message">{output}</div>;
}
