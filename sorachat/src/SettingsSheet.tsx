export function SettingsSheet({
  theme,
  onThemeChange,
  onClose
}: {
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop settings-backdrop" onClick={onClose}>
      <section className="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="設定" onClick={(event) => event.stopPropagation()}>
        <header className="settings-heading">
          <div>
            <span className="eyebrow">PREFERENCES</span>
            <h2>設定</h2>
            <p>使いやすい表示にカスタマイズできます。</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる"><i className="fa-solid fa-xmark" /></button>
        </header>
        <div className="settings-section">
          <h3><i className="fa-solid fa-palette" /> 外観</h3>
          <p className="muted">アプリ全体のテーマを選択します。</p>
          <div className="theme-options">
            <button className={`theme-option ${theme === "light" ? "selected" : ""}`} onClick={() => onThemeChange("light")} aria-pressed={theme === "light"}>
              <span className="theme-preview light-preview"><i className="fa-solid fa-sun" /></span>
              <span><strong>ライト</strong><small>明るく見やすい表示</small></span>
              {theme === "light" && <i className="fa-solid fa-circle-check selected-mark" />}
            </button>
            <button className={`theme-option ${theme === "dark" ? "selected" : ""}`} onClick={() => onThemeChange("dark")} aria-pressed={theme === "dark"}>
              <span className="theme-preview dark-preview"><i className="fa-solid fa-moon" /></span>
              <span><strong>ダーク</strong><small>暗い場所でも快適</small></span>
              {theme === "dark" && <i className="fa-solid fa-circle-check selected-mark" />}
            </button>
          </div>
        </div>
        <div className="settings-section">
          <h3><i className="fa-solid fa-circle-info" /> アプリについて</h3>
          <div className="settings-info-row"><span>SoraChat</span><span>メッセージを、もっと自然に。</span></div>
        </div>
        <button className="btn primary wide" onClick={onClose}>完了</button>
      </section>
    </div>
  );
}
