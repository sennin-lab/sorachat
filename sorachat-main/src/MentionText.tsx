// 本文の「@ユーザー名」を、グループのメンバーなら強調して表示する
export function MentionText({ text, users, meName }: { text: string; users: Set<string>; meName: string }) {
  const parts = text.split(/(@[a-z0-9_]{3,20})/gi);
  return (
    <>
      {parts.map((part, i) => {
        if (!part.startsWith("@")) return <span key={i}>{part}</span>;
        const name = part.slice(1).toLowerCase();
        if (!users.has(name)) return <span key={i}>{part}</span>;
        return (
          <span key={i} className={`mention${name === meName ? " me" : ""}`}>
            {part}
          </span>
        );
      })}
    </>
  );
}
