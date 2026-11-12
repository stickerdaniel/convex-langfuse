import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Corners } from "./ui";

export type Tab = "home" | "generation";

export function Header(props: { tab: Tab; onTab: (tab: Tab) => void }) {
  const health = useQuery(api.example.health);

  return (
    <div className="hero-frame">
      <Corners />

      <div className="hero-stats">
        <span>
          <strong>{health?.pendingAtLeast ?? 0}</strong> pending
        </span>
        <span className="dot">/</span>
        <span>
          <strong>{health?.exporter.accepted ?? 0}</strong> accepted
        </span>
        <span className="dot">/</span>
        <span>
          <strong>{health?.deadLettersAtLeast ?? 0}</strong> dead letters
        </span>
      </div>

      <div className="hero-divider" />

      <div className="hero-main">
        <div className="wordmark">
          <span className="logo-mark">λ</span> convex-langfuse
        </div>
        <h1 className="hero-title">
          LLM <span className="hl">OBSERVABILITY</span>
          <br />
          WIRED INTO CONVEX
        </h1>
        <p className="hero-sub">
          Record traces in your Convex transactions. A transactional outbox exports them to
          Langfuse over OpenTelemetry.
        </p>
      </div>

      <div className="hero-stripe" />
      <div className="hero-divider" />

      <div className="tabs">
        <button
          className={`tab${props.tab === "home" ? " active" : ""}`}
          onClick={() => props.onTab("home")}
        >
          Overview
        </button>
        <button
          className={`tab${props.tab === "generation" ? " active" : ""}`}
          onClick={() => props.onTab("generation")}
        >
          Record a generation
        </button>
      </div>
    </div>
  );
}
