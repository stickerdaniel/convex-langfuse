import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { formatTime } from "../lib/format";
import { Badge, Card } from "./ui";

function Row(props: { label: string; children: ReactNode }) {
  return (
    <li className="obs-item">
      <div className="obs-top">
        <span>{props.label}</span>
        <span className="mono">{props.children}</span>
      </div>
    </li>
  );
}

function YesNo(props: { value: boolean }) {
  return <Badge tone={props.value ? "good" : "bad"}>{props.value ? "yes" : "no"}</Badge>;
}

export function OutboxStatus() {
  const health = useQuery(api.example.health);

  return (
    <Card
      title="Outbox"
      description="The component's export state. It updates as the exporter sends rows to Langfuse."
    >
      {health === undefined ? (
        <div className="empty">Loading…</div>
      ) : (
        <ul className="obs-list">
          <Row label="Enabled">
            <YesNo value={health.enabled} />
          </Row>
          <Row label="Accepting">
            <YesNo value={health.accepting} />
          </Row>
          <Row label="Pending">{health.pendingAtLeast}</Row>
          <Row label="Last accepted">
            {health.exporter.lastAcceptedAt === undefined
              ? "never"
              : formatTime(health.exporter.lastAcceptedAt)}
          </Row>
          <Row label="Consecutive failures">{health.exporter.consecutiveFailures}</Row>
          <Row label="Dead letters">{health.deadLettersAtLeast}</Row>
        </ul>
      )}
    </Card>
  );
}
