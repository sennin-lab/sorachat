import { useCallback, useEffect, useMemo, useState } from "react";
import { api, post } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { useExitClose } from "./useExitClose";
import type { StudioMeView, StudioWorkView } from "./types";

// senninstudio（作者の画面）。作品の公開と、自分の作品の削除（削除だけできる）
const LINK_HREF = "/api/auth/sennin/link";
type Kind = StudioWorkView["kind"];

const KINDS: { kind: Kind; label: string; text: string }[] = [
  { kind: "stamp_pack", label: "スタンプ", text: "PNG・GIF・WebPの画像を1〜24枚。縦横16〜512px、1枚1MBまで" },
  { kind: "theme", label: "外観", text: "吹き出しと背景、アクセントの3色を決めます" },
  { kind: "quiz", label: "クイズ", text: "4択の問題を5〜50問。対戦で5問ずつ出題されます" },
  { kind: "ai_style", label: "応答スタイル", text: "senninai の口調・長さ・絵文字の使い方を選びます" }
];

const KIND_LABEL: Record<Kind, string> = { stamp_pack: "スタンプ", theme: "外観", quiz: "クイズ", ai_style: "応答スタイル" };

const STATUS_TEXT = (w: StudioWorkView) => {
  if (w.status === "published") return { text: "販売中", tone: "ok" };
  if (w.status === "deleted") return { text: "削除済み（買った人は引き続き使えます）", tone: "muted" };
  if (w.hiddenReason === "reports") return { text: "通報が多いため自動で非公開", tone: "ng" };
  if (w.hiddenReason === "creator_suspended") return { text: "作者の停止中のため非公開", tone: "ng" };
  return { text: "運営により非公開", tone: "ng" };
};

type Question = { q: string; options: string[]; answer: number };
const blankQuestion = (): Question => ({ q: "", options: ["", "", "", ""], answer: 0 });

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function StudioSheet({ onClose }: { onClose: () => void }) {
  const { closing, close } = useExitClose(onClose);
  const [data, setData] = useState<StudioMeView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<"list" | "create">("list");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [toDelete, setToDelete] = useState<StudioWorkView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<StudioMeView>("/api/studio/me"));
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e, "作者の情報を読み込めませんでした。"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (work: StudioWorkView) => {
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/studio/works/${work.id}`, { method: "DELETE" });
      setNotice({ ok: true, text: `「${work.name}」を削除しました。すでに買った人は引き続き使えます。` });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, "削除できませんでした。") });
    } finally {
      setBusy(false);
      setToDelete(null);
      void load();
    }
  };

  const canCreate = Boolean(data?.linked && !data?.suspended);

  return (
    <>
      <div className={`sheet-backdrop${closing ? " is-closing" : ""}`} onClick={() => close()}>
        <div className={`sheet studio-sheet${closing ? " is-closing" : ""}`} role="dialog" aria-label="senninstudio" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-title-row">
            {view === "create" ? (
              <button type="button" className="icon-btn" onClick={() => setView("list")} aria-label="戻る">
                <Icon name="back" size={22} />
              </button>
            ) : (
              <span />
            )}
            <strong>senninstudio</strong>
            <button type="button" className="icon-btn modal-x" onClick={() => close()} aria-label="閉じる">
              ×
            </button>
          </div>

          <div className="studio-body">
            {loadError && <p className="store-error">{loadError}</p>}
            {notice && (
              <p className={`store-notice ${notice.ok ? "is-ok" : "is-ng"}`} role="status">
                {notice.text}
              </p>
            )}

            {!data && !loadError && <p className="store-empty">読み込み中…</p>}

            {data && view === "list" && (
              <>
                {!data.linked ? (
                  <section className="store-link-card">
                    <span className="store-link-icon">
                      <Icon name="link2" size={22} />
                    </span>
                    <strong>作者になるには、仙人アカウントと連携</strong>
                    <p>
                      作品を公開して売るには、仙人アカウントとの連携が必要です。売上は仙人アカウントのポイントで受け取ります（手数料はかかりません）。
                    </p>
                    <a className="btn-primary store-link-btn" href={LINK_HREF}>
                      仙人アカウントと連携する
                    </a>
                  </section>
                ) : data.suspended ? (
                  <p className="store-notice is-ng">
                    この作者アカウントは、作品の公開を停止されています。{data.suspendedReason ? `（理由: ${data.suspendedReason}）` : ""}
                  </p>
                ) : null}

                <section className="studio-summary">
                  <div>
                    <span>受け取った売上</span>
                    <strong>{data.earned.toLocaleString("ja-JP")} pt</strong>
                  </div>
                  <div>
                    <span>未払い</span>
                    <strong>{data.pending.toLocaleString("ja-JP")} pt</strong>
                  </div>
                </section>
                {data.pending > 0 && (
                  <p className="studio-hint">
                    未払いは、仙人アカウントの連携が有効なときに自動で払われます。払えないときは、いったん保留になります（連携を確認してください）。
                  </p>
                )}

                <button type="button" className="btn-primary studio-new" disabled={!canCreate} onClick={() => setView("create")}>
                  <Icon name="plus" size={18} /> 作品を作る
                </button>

                <h3 className="studio-heading">作品</h3>
                {data.works.length === 0 ? (
                  <p className="store-empty">まだ作品がありません。最初の作品を作ってみましょう。</p>
                ) : (
                  <ul className="store-list">
                    {data.works.map((work) => {
                      const status = STATUS_TEXT(work);
                      return (
                        <li key={work.id} className="store-card">
                          <div className="store-card-top">
                            {work.thumbUrl ? (
                              <img className="studio-thumb" src={work.thumbUrl} alt="" width={56} height={56} />
                            ) : (
                              <span className="store-icon" aria-hidden="true">
                                <Icon name="edit" size={20} />
                              </span>
                            )}
                            <div className="store-card-text">
                              <strong>{work.name}</strong>
                              <small>
                                {KIND_LABEL[work.kind]} ・ {work.price.toLocaleString("ja-JP")} pt ・ 販売 {work.sales} 件
                              </small>
                              <small className={`studio-status is-${status.tone}`}>{status.text}</small>
                            </div>
                          </div>
                          {work.status !== "deleted" && (
                            <div className="studio-card-actions">
                              <button type="button" className="btn-small danger" onClick={() => setToDelete(work)} disabled={busy}>
                                削除する
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}

            {data && view === "create" && (
              <CreateForm
                onDone={(text) => {
                  setNotice({ ok: true, text });
                  setView("list");
                  void load();
                }}
                onCancel={() => setView("list")}
              />
            )}
          </div>
        </div>
      </div>

      {toDelete && (
        <ConfirmDialog
          title="作品を削除しますか？"
          message={`「${toDelete.name}」の販売をやめます。すでに買った人は引き続き使えます。削除は取り消せません。`}
          confirmLabel="削除する"
          danger
          busy={busy}
          onConfirm={() => void remove(toDelete)}
          onCancel={() => setToDelete(null)}
        />
      )}
    </>
  );
}

// 作品の公開フォーム（種類ごとの入力欄）。送る前に基本の形だけ見て、細かい判定は作品を公開するときにサーバーが行う
function CreateForm({ onDone, onCancel }: { onDone: (text: string) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>("stamp_pack");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("100");
  const [thumb, setThumb] = useState<File | null>(null);
  const [stamps, setStamps] = useState<File[]>([]);
  const [colors, setColors] = useState({ mine: "#ffd6e5", bg: "#fff7fa", accent: "#e0789f" });
  const [questions, setQuestions] = useState<Question[]>(() => Array.from({ length: 5 }, blankQuestion));
  const [style, setStyle] = useState<{ tone: string; length: string; emoji: boolean }>({ tone: "ふつう", length: "ふつう", emoji: true });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const thumbUrl = useMemo(() => (thumb ? URL.createObjectURL(thumb) : null), [thumb]);
  useEffect(() => () => {
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  }, [thumbUrl]);

  const submit = async () => {
    setError("");
    if (!name.trim()) return setError("作品の名前を入力してください。");
    if (kind !== "stamp_pack" && !thumb) return setError("サムネイル画像を選んでください。");
    if (kind === "stamp_pack" && stamps.length === 0) return setError("スタンプ画像を1枚以上選んでください。");

    let payload: unknown = null;
    if (kind === "theme") payload = colors;
    if (kind === "ai_style") payload = style;
    if (kind === "quiz") {
      payload = { questions };
    }

    const form = new FormData();
    form.append("kind", kind);
    form.append("name", name.trim());
    form.append("description", description.trim());
    form.append("price", price);
    if (payload !== null) form.append("data", JSON.stringify(payload));
    if (thumb) form.append("thumb", thumb);
    for (const file of stamps) form.append("images", file);

    setSaving(true);
    try {
      await api<{ ok: boolean; id: string }>("/api/studio/works", { method: "POST", body: form });
      onDone(`「${name.trim()}」を公開しました。`);
    } catch (e) {
      setError(errorText(e, "公開できませんでした。"));
    } finally {
      setSaving(false);
    }
  };

  const updateQuestion = (index: number, next: Partial<Question>) =>
    setQuestions((list) => list.map((item, i) => (i === index ? { ...item, ...next } : item)));

  return (
    <div className="studio-form">
      <p className="studio-hint">公開は審査なしです。禁止事項（URL・連絡先・不適切な言葉など）は自動で確かめられ、引っかかると公開できません。</p>

      <div className="store-tabs" role="tablist" aria-label="作品の種類">
        {KINDS.map((k) => (
          <button key={k.kind} type="button" role="tab" aria-selected={kind === k.kind} className={`store-tab${kind === k.kind ? " on" : ""}`} onClick={() => setKind(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>
      <p className="store-tab-text">{KINDS.find((k) => k.kind === kind)?.text}</p>

      <label className="studio-field">
        <span>作品の名前（40文字まで）</span>
        <input className="auth-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="studio-field">
        <span>説明（300文字まで）</span>
        <textarea className="auth-input" rows={3} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="studio-field">
        <span>価格（10〜1000 pt）</span>
        <input className="auth-input" type="number" inputMode="numeric" min={10} max={1000} step={1} value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>

      <label className="studio-field">
        <span>サムネイル{kind === "stamp_pack" ? "（省略すると1枚目を使います）" : "（必須）"}</span>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setThumb(e.target.files?.[0] ?? null)} />
        {thumbUrl && <img className="studio-thumb-preview" src={thumbUrl} alt="サムネイルの見本" />}
      </label>

      {kind === "stamp_pack" && (
        <label className="studio-field">
          <span>スタンプ（{stamps.length}/24枚）</span>
          <input
            type="file"
            multiple
            accept="image/png,image/gif,image/webp"
            onChange={(e) => setStamps(Array.from(e.target.files ?? []).slice(0, 24))}
          />
        </label>
      )}

      {kind === "theme" && (
        <div className="studio-colors">
          {(
            [
              ["mine", "自分の吹き出し"],
              ["bg", "チャットの背景"],
              ["accent", "ボタンの色"]
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="studio-color">
              <span>{label}</span>
              <input type="color" value={colors[key]} onChange={(e) => setColors((c) => ({ ...c, [key]: e.target.value }))} />
            </label>
          ))}
          <div className="studio-color-preview" style={{ background: colors.bg }}>
            <span className="studio-bubble" style={{ background: colors.mine }}>
              こんにちは
            </span>
            <span className="studio-accent" style={{ background: colors.accent }} />
          </div>
        </div>
      )}

      {kind === "quiz" && (
        <div className="studio-quiz">
          {questions.map((item, index) => (
            <fieldset key={index} className="studio-question">
              <legend>{index + 1}問目</legend>
              <input className="auth-input" placeholder="問題文（100文字まで）" maxLength={100} value={item.q} onChange={(e) => updateQuestion(index, { q: e.target.value })} />
              {item.options.map((option, o) => (
                <label key={o} className="studio-option">
                  <input type="radio" name={`answer-${index}`} checked={item.answer === o} onChange={() => updateQuestion(index, { answer: o })} />
                  <input
                    className="auth-input"
                    placeholder={`選択肢 ${o + 1}（30文字まで）`}
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
              {questions.length > 5 && (
                <button type="button" className="btn-small danger" onClick={() => setQuestions((list) => list.filter((_, i) => i !== index))}>
                  この問題を消す
                </button>
              )}
            </fieldset>
          ))}
          <button type="button" className="btn-secondary" disabled={questions.length >= 50} onClick={() => setQuestions((list) => [...list, blankQuestion()])}>
            <Icon name="plus" size={16} /> 問題を追加（{questions.length}/50）
          </button>
          <p className="studio-hint">○印で正解を選んでください。4つの選択肢は重ならないようにしてください。</p>
        </div>
      )}

      {kind === "ai_style" && (
        <div className="studio-style">
          <label className="studio-field">
            <span>口調</span>
            <select className="auth-input" value={style.tone} onChange={(e) => setStyle((s) => ({ ...s, tone: e.target.value }))}>
              {["やさしい", "ていねい", "ふつう", "カジュアル"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="studio-field">
            <span>長さ</span>
            <select className="auth-input" value={style.length} onChange={(e) => setStyle((s) => ({ ...s, length: e.target.value }))}>
              {["短め", "ふつう", "詳しめ"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="studio-check">
            <input type="checkbox" checked={style.emoji} onChange={(e) => setStyle((s) => ({ ...s, emoji: e.target.checked }))} />
            <span>絵文字を使う</span>
          </label>
          <p className="studio-hint">自由な文章の指示は入れられません。選んだ項目だけが、senninai への指示になります。</p>
        </div>
      )}

      {error && <p className="store-error">{error}</p>}
      <div className="studio-form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          やめる
        </button>
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving}>
          {saving ? "公開しています…" : "公開する"}
        </button>
      </div>
    </div>
  );
}
