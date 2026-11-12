import { Card } from "./ui";

export function Home() {
  return (
    <>
      <Card title="What this example shows">
        <p className="card-desc" style={{ marginBottom: "0.75rem" }}>
          A mutation records an LLM call in the <span className="mark">same transaction</span> as
          its own writes. The component stores the observation in an outbox. It leaves Convex only
          if the mutation commits.
        </p>
        <p className="card-desc" style={{ marginBottom: "0.75rem" }}>
          A background exporter sends the outbox to Langfuse over OpenTelemetry. It retries
          failures with backoff and sends each observation with the same bytes every time.
        </p>
        <p className="card-desc" style={{ marginBottom: "0.75rem" }}>
          The <strong>Record a generation</strong> tab saves a completion as a note and records it
          as a generation. A second form adds a step under it. The <strong>Outbox</strong> card
          shows the export state live.
        </p>
      </Card>
      <Card title="Good to know">
        <ul
          style={{
            margin: 0,
            paddingLeft: "1.1rem",
            color: "var(--text-dim)",
            fontSize: "0.85rem",
            lineHeight: 1.6,
          }}
        >
          <li>
            The trace id is derived from the conversation id, so every turn of a conversation lands
            in one trace.
          </li>
          <li>
            Without <span className="mono">LANGFUSE_PUBLIC_KEY</span>,{" "}
            <span className="mono">LANGFUSE_SECRET_KEY</span> and{" "}
            <span className="mono">LANGFUSE_BASE_URL</span>, the component records nothing.
          </li>
          <li>
            The client is created with <span className="mono">content: "full"</span>. With{" "}
            <span className="mono">"none"</span>, input, output and status messages are not exported.
          </li>
        </ul>
      </Card>
    </>
  );
}
