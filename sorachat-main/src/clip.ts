// 途切れない長い英数字の並び（例：aaaa…、長いURL）を、表示だけ一定の長さで「...」に切る。
// 日本語の文章はスペースがなくても切らない（読めなくなるため）。
// 元の文章（コピー・編集・送信）はそのまま使う。
const LONG_RUN = /[!-~]{41,}/g;
const KEEP = 40;

export const clipLongWords = (text: string): string => text.replace(LONG_RUN, (run) => `${run.slice(0, KEEP)}...`);
