import { useState } from "react";
import "./theme.css";
import { Header, type Tab } from "./components/Header";
import { TopBanner } from "./components/TopBanner";
import { Console } from "./components/Console";
import { Home } from "./components/Home";
import { LogGeneration, type Generation } from "./components/LogGeneration";
import { ContinueTrace } from "./components/ContinueTrace";
import { OutboxStatus } from "./components/OutboxStatus";

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [userId] = useState(() => randomId("user"));
  const [conversationId] = useState(() => randomId("conversation"));
  const [generation, setGeneration] = useState<Generation | null>(null);

  return (
    <div className="shell">
      <div className="main">
        <Header tab={tab} onTab={setTab} />
        <TopBanner />

        {tab === "home" && <Home />}

        {tab === "generation" && (
          <>
            <LogGeneration
              userId={userId}
              conversationId={conversationId}
              onGeneration={setGeneration}
            />
            <ContinueTrace conversationId={conversationId} generation={generation} />
            <OutboxStatus />
          </>
        )}
      </div>
      <Console />
    </div>
  );
}
