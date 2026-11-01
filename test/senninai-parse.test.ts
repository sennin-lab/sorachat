import "./env.ts";
import { recipientsToNotify } from "../server/messages.ts";
import assert from "node:assert/strict";
import { fitTranscript, mentionedMembers, normalizeName, parseClassifierJson, parseDmIntent, parseGroupCommand, PREVIOUS } from "../server/senninai.ts";

let passed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
};

// グループのコマンド
check("add", () => assert.deepEqual(parseGroupCommand("/senninai add"), { kind: "add" }));
check("add (参加)", () => assert.deepEqual(parseGroupCommand("/senninai 参加"), { kind: "add" }));
check("ask", () => assert.deepEqual(parseGroupCommand("/senninai ask 今日の天気は？"), { kind: "ask", question: "今日の天気は？" }));
check("ask with newline", () => assert.deepEqual(parseGroupCommand("/senninai ask 1行目\n2行目"), { kind: "ask", question: "1行目\n2行目" }));
check("ask empty", () => assert.deepEqual(parseGroupCommand("/senninai ask"), { kind: "ask", question: "" }));
check("bare command is invalid", () => assert.equal(parseGroupCommand("/senninai"), null));
check("no space is not a command", () => assert.equal(parseGroupCommand("/senninaiask x"), null));
check("unknown subcommand", () => assert.equal(parseGroupCommand("/senninai hello"), null));

// トークでの話しかけ：送信
check("send quoted", () =>
  assert.deepEqual(parseDmIntent("太郎に『明日遅れます』と送って"), { kind: "send", target: "太郎", body: "明日遅れます" }));
check("send unquoted with って", () =>
  assert.deepEqual(parseDmIntent("太郎に明日遅れるって送って"), { kind: "send", target: "太郎", body: "明日遅れる" }));
check("send with 伝えて", () =>
  assert.deepEqual(parseDmIntent("太郎に明日遅れると伝えて"), { kind: "send", target: "太郎", body: "明日遅れる" }));
check("send with さん suffix in name", () =>
  assert.deepEqual(parseDmIntent("田中さんに「ありがとう」って送っといて"), { kind: "send", target: "田中", body: "ありがとう" }));
check("send 'this content' refers to previous message", () =>
  assert.deepEqual(parseDmIntent("田中さんにこの内容を送ってや"), { kind: "send", target: "田中", body: PREVIOUS }));
check("send without body", () => assert.deepEqual(parseDmIntent("太郎に送って"), { kind: "send", target: "太郎", body: "" }));
check("question about sent messages is not a send", () =>
  assert.deepEqual(parseDmIntent("太郎に送ったメッセージ見た？"), { kind: "chat" }));

// 読んで答える
check("read with question", () =>
  assert.deepEqual(parseDmIntent("太郎とのチャットを読んで丸々について教えて"), { kind: "read", target: "太郎", question: "丸々について教えて" }));
check("read summary", () =>
  assert.deepEqual(parseDmIntent("グループAとのトークを要約して"), { kind: "read", target: "グループA", question: "要約して" }));
check("read without question gets default", () =>
  assert.deepEqual(parseDmIntent("太郎との会話を読んで"), { kind: "read", target: "太郎", question: "要点をまとめてください" }));

// ふつうの質問はAIへ
check("plain chat", () => assert.deepEqual(parseDmIntent("日本の首都はどこ？"), { kind: "chat" }));
check("に without send verb is chat", () => assert.deepEqual(parseDmIntent("東京に行きたい"), { kind: "chat" }));

// 名前の表記ゆれ
check("normalize suffix + width", () => assert.equal(normalizeName("ＴＡＲＯ さん"), normalizeName("taro")));

// 会話の長さ
check("fitTranscript keeps newest within budget", () => {
  const lines = ["a".repeat(10), "b".repeat(10), "c".repeat(10)];
  assert.deepEqual(fitTranscript(lines, 25), ["b".repeat(10), "c".repeat(10)]);
  assert.deepEqual(fitTranscript(lines, 1000), lines);
  // 1行だけでも予算を超えるなら、その1行は残す（空にしない）
  assert.deepEqual(fitTranscript(["x".repeat(50)], 10), ["x".repeat(50)]);
});

// 返信案・読み取りの言い回し
check("reply", () => assert.deepEqual(parseDmIntent("太郎への返信を考えて"), { kind: "reply", target: "太郎" }));
check("read with 見て after との", () =>
  assert.deepEqual(parseDmIntent("太郎とのやり取りを見て、要点は？"), { kind: "read", target: "太郎", question: "要点は？" }));

// AIの判定結果（JSON）の読み取り
check("classifier read", () =>
  assert.deepEqual(parseClassifierJson('はい。{"action":"read","target":"太郎","question":"予定"}'), { kind: "read", target: "太郎", question: "予定" }));
check("classifier send needs target and body", () => {
  assert.deepEqual(parseClassifierJson('{"action":"send","target":"太郎","body":"了解"}'), { kind: "send", target: "太郎", body: "了解" });
  assert.equal(parseClassifierJson('{"action":"send","target":"太郎"}'), null);
});
check("classifier rejects garbage and unknown actions", () => {
  assert.equal(parseClassifierJson("わかりません"), null);
  assert.equal(parseClassifierJson('{"action":"delete_all"}'), null);
  assert.equal(parseClassifierJson("{not json}"), null);
  assert.equal(parseClassifierJson('{"action":"read","target":""}'), null);
});
check("classifier chat", () => assert.deepEqual(parseClassifierJson('{"action":"chat"}'), { kind: "chat" }));

// 人の名前の検出
check("mentioned member by name", () =>
  assert.deepEqual(mentionedMembers("太郎のことどう思う？", [{ id: "a", name: "太郎" }, { id: "b", name: "アリス" }]), [{ id: "a", name: "太郎" }]));
check("no member mentioned", () => assert.deepEqual(mentionedMembers("今日は晴れ？", [{ id: "a", name: "太郎" }]), []));

check("recipientsToNotify skips sender, muted and blocked", () =>
  assert.deepEqual(recipientsToNotify(["a", "b", "c", "d"], "a", new Set(["c"])), ["b", "d"]));

console.log(`all ${passed} parser checks passed`);
