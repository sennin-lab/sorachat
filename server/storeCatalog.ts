// 仙人ストアの商品一覧。価格は仙人アカウントのポイント（1pt = 1）。
// 商品を増やす・値段を変えるときは、この配列を編集するだけで画面と判定に反映されます。
// price が 0 の商品は無料（買わなくても使える）。
//
// 種類:
// - theme       … 外観。自分のトークの吹き出し・背景・アクセント色を変える（表示は本人の画面だけ）
// - stamp_pack  … スタンプパック。stamps に入れたスタンプは、パックを買うまで新しく送れない
// - extension   … 拡張機能。feature で決まる機能（bot:group・game:◯◯）を買うと使える
//
// stamps の名前は「src/stamps/ のファイル名を文字に戻したもの」（例: builtin:おめでとう.png）。
// 画面の表示名と送信の判定は、同じ正規化（server/stampRef.ts の normalizeStampRef）で合わせている。

export type StoreKind = "theme" | "stamp_pack" | "extension";

export type StoreItem = {
  id: string;
  kind: StoreKind;
  name: string;
  description: string;
  price: number;
  stamps?: string[];
  feature?: string;
};

export const STORE_ITEMS: StoreItem[] = [
  {
    id: "theme-sakura",
    kind: "theme",
    name: "さくら",
    description: "吹き出しとチャットの背景を、やわらかいさくら色に",
    price: 200
  },
  {
    id: "theme-matcha",
    kind: "theme",
    name: "抹茶",
    description: "落ち着いた若葉色で、トーク画面を明るく",
    price: 200
  },
  {
    id: "theme-sora",
    kind: "theme",
    name: "そら",
    description: "澄んだ空色のアクセントに",
    price: 300
  },
  {
    id: "theme-yuyake",
    kind: "theme",
    name: "夕焼け",
    description: "あたたかいオレンジ色の吹き出しに",
    price: 300
  },
  {
    id: "stamp-pack-1",
    kind: "stamp_pack",
    name: "プレミアムスタンプ 1",
    description: "おめでとう・やったー・ファイトなど、6種類のスタンプ",
    price: 500,
    stamps: [
      "builtin:おめでとう.png",
      "builtin:やったー.png",
      "builtin:すごい.png",
      "builtin:頑張って.png",
      "builtin:ファイト.png",
      "builtin:大丈夫.png"
    ]
  },
  {
    id: "ext-bot-group",
    kind: "extension",
    name: "senninai をグループに入れる",
    description: "グループで「/senninai add」を使えるようになります（senninai のグループ参加）",
    price: 300,
    feature: "bot:group"
  },
  {
    id: "ext-game-janken",
    kind: "extension",
    name: "ミニゲーム：じゃんけん大会",
    description: "じゃんけん大会をグループで遊べるようになります",
    price: 100,
    feature: "game:janken"
  },
  {
    id: "ext-game-guess",
    kind: "extension",
    name: "ミニゲーム：数当て",
    description: "1〜100の数字を当てるゲームをグループで遊べるようになります",
    price: 100,
    feature: "game:guess"
  }
];

const byId = new Map(STORE_ITEMS.map((item) => [item.id, item]));
export const storeItemById = (id: string): StoreItem | null => byId.get(id) ?? null;

// 機能名 → その機能を開く商品
const byFeature = new Map<string, StoreItem>();
for (const item of STORE_ITEMS) if (item.feature) byFeature.set(item.feature, item);
export const storeItemForFeature = (feature: string): StoreItem | null => byFeature.get(feature) ?? null;

// スタンプの正規化した名前 → それを含むパックの商品ID
export const stampPackOf = new Map<string, string>();
for (const item of STORE_ITEMS) {
  if (item.kind !== "stamp_pack") continue;
  for (const ref of item.stamps ?? []) stampPackOf.set(ref, item.id);
}
