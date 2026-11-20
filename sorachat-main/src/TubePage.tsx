import { Page } from "./Page";

// 仙人Tube Plus は、ソラチャットのサーバーの中（/tube）で動く。同じ場所を画面の中で開く
export function TubePage({ onBack }: { onBack: () => void }) {
  return (
    <Page title="仙人Tube Plus" onBack={onBack} wide>
      <iframe className="tube-frame" src="/tube/" title="仙人Tube Plus" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" />
    </Page>
  );
}
