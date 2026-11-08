import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Icon } from "./Icon";
import { errorText, KIND_LABEL, yen } from "./storeUi";
import type { StudioWorkView, WorkKind } from "./types";

type Kind = WorkKind;
type Question = { q: string; options: string[]; answer: number };

const KINDS: { kind: Kind; label: string; text: string }[] = [
  { kind: "stamp_pack", label: "スタンプパック", text: "PNG・GIF・WebP の画像を 1〜24 枚。縦横 16〜512px、1 枚 1MB まで" },
  { kind: "theme", label: "外観", text: "吹き出し・背景・ボタンの 3 色を決めます（#RRGGBB）" },
  { kind: "quiz", label: "クイズ", text: "4 択の問題を 5〜50 問。対戦で 5 問ずつ出題されます" },
  { kind: "ai_style", label: "応答スタイル", text: "senninai の口調・長さ・絵文字の使い方を選びます" }
];

const TONES = ["やさしい", "ていねい", "ふつう", "カジュアル"];
const LENGTHS = ["短め", "ふつう", "詳しめ"];
const URL_LIKE = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|jp|io|app|xyz|top|info|biz)\b)/i;
const EMAIL_LIKE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

const blankQuestion = (): Question => ({ q: "", options: ["", "", "", ""], answer: 0 });

const initialQuestions = (payload: Record<string, unknown>): Question[] => {
  const list = Array.isArray(payload.questions) ? (payload.questions as Question[]) : [];
  return list.length ? list.map((q) => ({ q: q.q, options: [...q.options], answer: q.answer })) : Array.from({ length: 5 }, blankQuestion);
};

// 作品の作成（mode が create）と編集（mode が edit）で共通のエディタ。
// 送る前に、サーバーの自動チェックと同じ条件をこの画面でも確かめて、結果をチェックリストで見せる。
export function StudioEditor({
  mode,
  initial,
  onDone,
  onCancel
}: {
  mode: "create" | "edit";
  initial: StudioWorkView | null;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const editing = mode === "edit" && initial !== null;
  const payload = (initial?.payload ?? {}) as Record<string, unknown>;

  const [kind, setKind] = useState<Kind>(initial?.kind ?? "stamp_pack");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(String(initial?.price ?? 100));
  const [thumb, setThumb] = useState<File | null>(null);
  const [stamps, setStamps] = useState<File[]>([]);
  const [colors, setColors] = useState({
    mine: typeof payload.mine === "string" ? payload.mine : "#ffd6e5",
    bg: typeof payload.bg === "string" ? payload.bg : "#fff7fa",
    accent: typeof payload.accent === "string" ? payload.accent : "#e0789f"
  });
  const [questions, setQuestions] = useState<Question[]>(() => initialQuestions(payload));
  const [style, setStyle] = useState<{ tone: string; length: string; emoji: boolean }>({
    tone: typeof payload.tone === "string" ? payload.tone : "ふつう",
    length: typeof payload.length === "string" ? payload.length : "ふつう",
    emoji: typeof payload.emoji === "boolean" ? payload.emoji : true
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // 選んだサムネイルの見本（使い終わったら解放する）
  const thumbUrl = useMemo(() => (thumb ? URL.createObjectURL(thumb) : null), [thumb]);
  useEffect(
    () => () => {
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    },
    [thumbUrl]
  );

  const currentThumb = thumbUrl ?? initial?.thumbUrl ?? null;
  const priceNumber = Number(price);
  const nameTrim = name.trim();
  const allText = `${name} ${description} ${kind === "quiz" ? questions.map((q) => `${q.q} ${q.options.join(" ")}`).join(" ") : ""}`;

  // 公開前チェック（サーバーと同じ条件。最後の判定はサーバーが行う）
  const checks = useMemo(() => {
    const list: { label: string; ok: boolean }[] = [
      { label: "作品の名前（1〜40文字）", ok: nameTrim.length >= 1 && nameTrim.length <= 40 },
      { label: "説明（300文字まで）", ok: description.length <= 300 },
      { label: "価格（10〜1000 pt の整数）", ok: Number.isInteger(priceNumber) && priceNumber >= 10 && priceNumber <= 1000 },
      { label: "URL・メールアドレス・電話番号を含まない", ok: !URL_LIKE.test(allText) && !EMAIL_LIKE.test(allText) }
    ];
    if (kind === "stamp_pack") {
      if (!editing) list.push({ label: "スタンプ画像（1〜24 枚）", ok: stamps.length >= 1 && stamps.length <= 24 });
    } else {
      list.push({ label: "サムネイル画像", ok: Boolean(currentThumb) });
    }
    if (kind === "theme") {
      list.push({ label: "配色（#RRGGBB）", ok: [colors.mine, colors.bg, colors.accent].every((c) => /^#[0-9a-fA-F]{6}$/.test(c)) });
    }
    if (kind === "quiz") {
      list.push({ label: "問題（5〜50 問）", ok: questions.length >= 5 && questions.length <= 50 });
      list.push({
        label: "各問：問題文と4つの選択肢（重ならない）",
        ok: questions.every((q) => q.q.trim() && q.options.every((o) => o.trim()) && new Set(q.options.map((o) => o.trim())).size === 4)
      });
    }
    return list;
  }, [allText, colors, currentThumb, description, editing, kind, nameTrim, priceNumber, questions, stamps.length]);

  const allOk = checks.every((c) => c.ok);

  const updateQuestion = (index: number, next: Partial<Question>) =>
    setQuestions((list) => list.map((item, i) => (i === index ? { ...item, ...next } : item)));

  const submit = async () => {
    setError("");
    if (!nameTrim) return setError("作品の名前を入力してください。");
    if (!editing && kind !== "stamp_pack" && !thumb) return setError("サムネイル画像を選んでください。");
    if (!editing && kind === "stamp_pack" && stamps.length === 0) return setError("スタンプ画像を1枚以上選んでください。");

    let data: unknown = null;
    if (kind === "theme") data = colors;
    if (kind === "ai_style") data = style;
    if (kind === "quiz") data = { questions };

    const form = new FormData();
    form.append("name", nameTrim);
    form.append("description", description.trim());
    form.append("price", price);
    if (data !== null) form.append("data", JSON.stringify(data));
    if (thumb) form.append("thumb", thumb);
    if (!editing) {
      form.append("kind", kind);
      for (const file of stamps) form.append("images", file);
    }

    setSaving(true);
    try {
      if (editing && initial) {
        await api<{ ok: boolean }>(`/api/studio/works/${initial.id}/edit`, { method: "POST", body: form });
        onDone(`「${nameTrim}」を更新しました。買った人の画面にも反映されます。`);
      } else {
        await api<{ ok: boolean; id: string }>("/api/studio/works", { method: "POST", body: form });
        onDone(`「${nameTrim}」を公開しました。`);
      }
    } catch (e) {
      setError(errorText(e, editing ? "更新できませんでした。" : "公開できませんでした。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dev-editor">
      <div className="dev-editor-form">
        {editing ? (
          <p className="dev-note">
            種類は「{KIND_LABEL[kind]}」のまま変えられません。スタンプ画像は、買った人の手元に残るため差し替えられません（作り直して公開してください）。
          </p>
        ) : (
          <fieldset className="dev-kinds">
            <legend>作品の種類</legend>
            {KINDS.map((k) => (
              <label key={k.kind} className={`dev-kind${kind === k.kind ? " on" : ""}`}>
                <input type="radio" name="kind" checked={kind === k.kind} onChange={() => setKind(k.kind)} />
                <strong>{k.label}</strong>
                <small>{k.text}</small>
              </label>
            ))}
          </fieldset>
        )}

        <div className="dev-fields">
          <label className="dev-field">
            <span>作品の名前（40 文字まで）</span>
            <input className="dev-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="dev-field">
            <span>説明（300 文字まで）</span>
            <textarea className="dev-input" rows={3} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="dev-field">
            <span>価格（10〜1000 pt）</span>
            <input className="dev-input" type="number" inputMode="numeric" min={10} max={1000} step={1} value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>

          <label className="dev-field">
            <span>サムネイル{kind === "stamp_pack" ? "（省略すると1枚目を使います）" : "（必須）"}{editing ? "・変えるときだけ選択" : ""}</span>
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setThumb(e.target.files?.[0] ?? null)} />
          </label>
          {currentThumb && <img className="dev-thumb-preview" src={currentThumb} alt="サムネイルの見本" />}

          {kind === "stamp_pack" && (
            <label className="dev-field">
              <span>{editing ? "スタンプ（編集では変えられません）" : `スタンプ（${stamps.length}/24 枚）`}</span>
              {editing ? (
                <small className="dev-muted">現在の内容はそのままです。</small>
              ) : (
                <input type="file" multiple accept="image/png,image/gif,image/webp" onChange={(e) => setStamps(Array.from(e.target.files ?? []).slice(0, 24))} />
              )}
            </label>
          )}

          {kind === "theme" && (
            <div className="dev-colors">
              {(
                [
                  ["mine", "自分の吹き出し"],
                  ["bg", "チャットの背景"],
                  ["accent", "ボタンの色"]
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="dev-color">
                  <span>{label}</span>
                  <input type="color" value={colors[key]} onChange={(e) => setColors((c) => ({ ...c, [key]: e.target.value }))} />
                </label>
              ))}
              <div className="dev-color-preview" style={{ background: colors.bg }}>
                <span className="cws-theme-bubble" style={{ background: colors.mine }}>
                  こんにちは
                </span>
                <span className="cws-theme-accent" style={{ background: colors.accent }} />
              </div>
            </div>
          )}

          {kind === "quiz" && (
            <div className="dev-quiz">
              {questions.map((item, index) => (
                <fieldset key={index} className="dev-question">
                  <legend>
                    {index + 1} 問目
                    {questions.length > 5 && (
                      <button type="button" className="cws-text-btn danger" onClick={() => setQuestions((list) => list.filter((_, i) => i !== index))}>
                        削除
                      </button>
                    )}
                  </legend>
                  <input className="dev-input" placeholder="問題文（100 文字まで）" maxLength={100} value={item.q} onChange={(e) => updateQuestion(index, { q: e.target.value })} />
                  {item.options.map((option, o) => (
                    <label key={o} className="dev-option">
                      <input type="radio" name={`answer-${index}`} checked={item.answer === o} onChange={() => updateQuestion(index, { answer: o })} aria-label={`正解は選択肢 ${o + 1}`} />
                      <input
                        className="dev-input"
                        placeholder={`選択肢 ${o + 1}（30 文字まで）`}
                        maxLength={30}
                        value={option}
                        onChange={(e) => {
                          const next = [...item.options];
                          next[o] = e.target.value;
                          updateQuestion(index, { options: next });
                        }}
                      />
                    </label>
                  ))}
                </fieldset>
              ))}
              <button type="button" className="cws-outline" disabled={questions.length >= 50} onClick={() => setQuestions((list) => [...list, blankQuestion()])}>
                <Icon name="plus" size={16} /> 問題を追加（{questions.length}/50）
              </button>
              <p className="dev-muted">○ で正解を選んでください。4 つの選択肢は重ならないようにしてください。</p>
            </div>
          )}

          {kind === "ai_style" && (
            <div className="dev-style">
              <label className="dev-field">
                <span>口調</span>
                <select className="dev-input" value={style.tone} onChange={(e) => setStyle((s) => ({ ...s, tone: e.target.value }))}>
                  {TONES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="dev-field">
                <span>長さ</span>
                <select className="dev-input" value={style.length} onChange={(e) => setStyle((s) => ({ ...s, length: e.target.value }))}>
                  {LENGTHS.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="dev-check">
                <input type="checkbox" checked={style.emoji} onChange={(e) => setStyle((s) => ({ ...s, emoji: e.target.checked }))} />
                <span>絵文字を使う</span>
              </label>
              <p className="dev-muted">自由な文章の指示は入れられません。選んだ項目だけが senninai への指示になります。</p>
            </div>
          )}
        </div>

        {error && <p className="cws-error-inline">{error}</p>}
        <div className="dev-actions">
          <button type="button" className="cws-outline" onClick={onCancel} disabled={saving}>
            やめる
          </button>
          <button type="button" className="cws-primary" onClick={() => void submit()} disabled={saving || (!editing && !allOk)}>
            {saving ? (editing ? "保存しています…" : "公開しています…") : editing ? "変更を保存" : "公開する"}
          </button>
        </div>
      </div>

      <aside className="dev-editor-side">
        <section className="dev-panel">
          <h3>公開前チェック</h3>
          <ul className="dev-checks">
            {checks.map((c) => (
              <li key={c.label} className={c.ok ? "is-ok" : "is-ng"}>
                <Icon name={c.ok ? "check" : "close"} size={14} />
                <span>{c.label}</span>
              </li>
            ))}
          </ul>
          <p className="dev-muted">審査はありません。ここで確かめた内容は、公開のときにサーバーでも同じように確かめられます。</p>
        </section>

        <section className="dev-panel">
          <h3>掲載プレビュー</h3>
          <div className="cws-card cws-card-preview">
            <div className="cws-card-open">
              {currentThumb ? (
                <img className="cws-icon-img" src={currentThumb} alt="" width={56} height={56} style={{ width: 56, height: 56 }} />
              ) : (
                <span className="cws-icon-fallback" style={{ width: 56, height: 56 }} aria-hidden="true" />
              )}
              <span className="cws-card-body">
                <strong className="cws-card-title">{nameTrim || "作品の名前"}</strong>
                <span className="cws-card-desc">{description || "説明がここに表示されます。"}</span>
              </span>
            </div>
            <div className="cws-card-foot">
              <span className="cws-price">{Number.isInteger(priceNumber) && priceNumber > 0 ? `${yen(priceNumber)} pt` : "— pt"}</span>
              <span className="cws-kind">{KIND_LABEL[kind]}</span>
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}
