import QRCode from "qrcode";

// 自分のQRに入れる値。読み取り側はこの形式からユーザー名を取り出す
export const profileQrValue = (username: string) => `sorachat://user/${username}`;

// 外部サービスを使わず端末内で生成する（CSPで外部画像が止まるため）
export const makeQrImage = (text: string) =>
  QRCode.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });

// 読み取った文字列からユーザー名を取り出す（sorachat://user/xxx または @xxx）
export const usernameFromQr = (value: string) => {
  const match = value.trim().match(/(?:sorachat:\/\/user\/|@)([a-z0-9_]{3,20})\/?$/i);
  return match ? match[1].toLowerCase() : null;
};
