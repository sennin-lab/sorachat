// 早押しクイズの問題を、senninai（AI）が毎回ランダムに作る。
// 失敗したとき（AIが止まっている・形式が違う・時間切れ）は null を返し、呼び出し側が固定の問題を使う。
import { QUIZ_ROUNDS, type QuizQuestion } from "./gameLogic.js";
import { askAi } from "./senninai.js";

const GENERATE_TIMEOUT_MS = 25_000;
export const GENRE_MAX = 30;

// 毎回の題材をばらすための候補（組み合わせて使う）
const THEMES = [
  "日本の都道府県と地理",
  "日本の歴史（縄文〜江戸）",
  "日本の食べ物と郷土料理",
  "京都・奈良のお寺や神社",
  "日本の山・川・湖",
  "世界の国と首都",
  "動物の生態",
  "植物と花",
  "宇宙と天文",
  "身近な科学（物理・化学）",
  "漢字と言葉の由来",
  "日本の祭りと行事",
  "スポーツのルール",
  "音楽と楽器",
  "世界の有名な建築物",
  "お金と経済の基本",
  "日本のアニメ・マンガの常識",
  "数字にまつわる雑学",
  "乗り物と交通",
  "海と海の生き物"
];

const ANGLES = ["入門編", "少しひねった問題", "ちょっと難しめ", "身近なものに関する問題", "意外と知らない豆知識", "歴史的な出来事"];

const pick = <T>(list: T[], random: () => number): T => list[Math.floor(random() * list.length)];

const shuffleIndexes = (random: () => number): number[] => {
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
};

// AIの返事から JSON 配列を読み取り、形の正しい問題だけを取り出す（4択・正解は0〜3）
export function parseQuizJson(raw: string): QuizQuestion[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const questions: QuizQuestion[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { q, options, answer } = item as { q?: unknown; options?: unknown; answer?: unknown };
    if (typeof q !== "string" || !Array.isArray(options) || typeof answer !== "number") continue;
    const text = q.trim();
    const choices = options.map((o) => (typeof o === "string" ? o.trim() : ""));
    if (!text || text.length > 120) continue;
    if (choices.length !== 4 || choices.some((c) => !c || c.length > 40) || new Set(choices).size !== 4) continue;
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) continue;
    questions.push({ q: text, options: choices, answer });
  }
  return questions.length >= QUIZ_ROUNDS ? questions.slice(0, QUIZ_ROUNDS) : null;
}

// 正解の位置が毎回ばらつくように、選択肢の順番を入れ替える
function scramble(questions: QuizQuestion[], random: () => number): QuizQuestion[] {
  return questions.map((question) => {
    const order = shuffleIndexes(random);
    return {
      q: question.q,
      options: order.map((i) => question.options[i]),
      answer: order.indexOf(question.answer)
    };
  });
}

// genre を渡すと、そのジャンルで作る（空や未指定なら、候補からランダムに選ぶ）
export async function generateQuizQuestions(random: () => number = Math.random, genre = ""): Promise<QuizQuestion[] | null> {
  const customTheme = genre.replace(/[\r\n]/g, " ").trim().slice(0, GENRE_MAX);
  const theme = customTheme || pick(THEMES, random);
  const angle = pick(ANGLES, random);
  const seed = Math.floor(random() * 1_000_000).toString(36);
  const prompt = [
    `クイズ作家として、次の条件で4択クイズを${QUIZ_ROUNDS}問作ってください。`,
    `- テーマ: ${theme}（切り口: ${angle}）`,
    "- 毎回違う問題にしてください（ランダムID: " + seed + "）。",
    "- 正解が一つに決まる問題だけにしてください。選択肢はすべて違う内容にしてください。",
    "- 対象は中学生が楽しめる程度です。",
    "- 出力は JSON の配列だけにしてください。説明文やマークダウンは付けないでください。",
    '- 形式: [{"q":"問題文","options":["選択肢1","選択肢2","選択肢3","選択肢4"],"answer":0}]',
    "- answer は正解の選択肢の番号（0〜3）です。"
  ].join("\n");
  try {
    const raw = await Promise.race([
      askAi([{ role: "user", content: prompt }], 4000),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), GENERATE_TIMEOUT_MS))
    ]);
    const parsed = parseQuizJson(raw);
    return parsed ? scramble(parsed, random) : null;
  } catch (error) {
    console.error("クイズの問題を作れませんでした（固定の問題を使います）:", error);
    return null;
  }
}
