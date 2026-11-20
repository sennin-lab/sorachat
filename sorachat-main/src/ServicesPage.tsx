import { Icon, type IconName } from "./Icon";
import { Page } from "./Page";

export type ServiceItem = { label: string; icon: IconName; group: string; run: () => void };

// 「サービス」のすべてを一覧で出す専用ページ。分類ごとに見出しを付け、1行ずつ押せるようにする
export function ServicesPage({
  items,
  onBack,
  onPick
}: {
  items: ServiceItem[];
  onBack: () => void;
  onPick: (item: ServiceItem) => void;
}) {
  const groups: string[] = [];
  for (const item of items) if (!groups.includes(item.group)) groups.push(item.group);

  return (
    <Page title="サービス" onBack={onBack}>
      <div className="services-page">
        {groups.map((group) => (
          <section key={group} className="services-group">
            <h2 className="services-group-title">{group}</h2>
            <ul className="services-list">
              {items
                .filter((item) => item.group === group)
                .map((item) => (
                  <li key={item.label}>
                    <button type="button" className="services-row" onClick={() => onPick(item)}>
                      <span className="services-row-icon">
                        <Icon name={item.icon} size={22} />
                      </span>
                      <span className="services-row-label">{item.label}</span>
                      <Icon name="chevron" size={18} className="chev" />
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </Page>
  );
}
