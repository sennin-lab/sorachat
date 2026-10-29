import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AdminApp } from "./Admin";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname.startsWith("/admin") ? <AdminApp /> : <App />}
  </StrictMode>
);
