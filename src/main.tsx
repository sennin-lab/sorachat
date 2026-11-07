import { StrictMode, Suspense, lazy } from "react";
import { BrowserRouter } from "react-router-dom";
import { createRoot } from "react-dom/client";
import App from "./App";
import { trackKeyboard } from "./keyboard";
import "./styles.css";
import { applyAppIcon } from "./iconPrefs";

applyAppIcon();

// 管理画面とステータス画面は、そのページを開いたときだけ読み込む（通常のチャット画面を軽くする）
const AdminApp = lazy(() => import("./Admin").then((m) => ({ default: m.AdminApp })));
const StatusPage = lazy(() => import("./StatusPage").then((m) => ({ default: m.StatusPage })));

const isAdmin = window.location.pathname.startsWith("/admin");
const isStatus = window.location.pathname.replace(/\/+$/, "") === "/status";

// チャットアプリ本体はページをスクロールさせない（スクロールは各領域の中だけ）
if (!isAdmin && !isStatus) {
  document.body.classList.add("app-root");
  trackKeyboard();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isAdmin ? (
      <Suspense fallback={null}>
        <AdminApp />
      </Suspense>
    ) : isStatus ? (
      <Suspense fallback={null}>
        <StatusPage />
      </Suspense>
    ) : (
      <BrowserRouter>
        <App />
      </BrowserRouter>
    )}
  </StrictMode>
);
