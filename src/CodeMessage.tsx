import { useState } from "react";
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

export function CodeMessage({ text, users, meName }: { text: string; users: Set<string>; meName: string }) {
  const [copied, setCopied] = useState<number | null>(null);
  const parts = text.split(/```([^\n`]*)\n([\s\S]*?)```/g);
  if (parts.length === 1) return <RichText text={text} users={users} meName={meName} />;
  const output = [];
  for (let i = 0; i < parts.length; ) {
    const plain = parts[i++];
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
