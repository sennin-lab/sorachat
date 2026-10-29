import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AdminApp } from "./Admin";
import { trackKeyboard } from "./keyboard";
import "./styles.css";

const isAdmin = window.location.pathname.startsWith("/admin");

// チャットアプリ本体はページをスクロールさせない（スクロールは各領域の中だけ）
if (!isAdmin) {
  document.body.classList.add("app-root");
  trackKeyboard();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isAdmin ? <AdminApp /> : <App />}
  </StrictMode>
);
