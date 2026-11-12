import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Card, Field, TextInput, Button } from "./ui";
import { withLog } from "../lib/logStore";
import type { Generation } from "./LogGeneration";

export function ContinueTrace(props: { conversationId: string; generation: Generation | null }) {
  const [name, setName] = useState("vector-search");
  const [input, setInput] = useState("convex components");
  const [output, setOutput] = useState("3 matches");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const recordStep = useMutation(api.example.recordStep);

  async function submit() {
    if (!props.generation) return;
    const parentObservationId = props.generation.observationId;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const result = await withLog(`recordStep(${name})`, () =>
        recordStep({ conversationId: props.conversationId, parentObservationId, name, input, output }),
      );
      setOk(result.observationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Add a step to the trace"
      description="Records a span, such as a retrieval or a tool call, in the same trace, nested under the generation."
    >
      {!props.generation ? (
        <div className="empty">Record a generation first. The step nests under it.</div>
      ) : (
        <>
          <div className="trace-ref">
            <span className="label">Parent observation</span>
            <span className="mono">{props.generation.observationId}</span>
          </div>
          <Field label="Step name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="row">
            <Field label="Input">
              <TextInput value={input} onChange={(e) => setInput(e.target.value)} />
            </Field>
            <Field label="Output">
              <TextInput value={output} onChange={(e) => setOutput(e.target.value)} />
            </Field>
          </div>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Recording…" : "Record step"}
          </Button>
          {error && <div className="error-text">{error}</div>}
          {ok && (
            <div className="trace-ref" style={{ marginTop: "1rem" }}>
              <span className="label">observationId</span>
              <span className="mono">{ok}</span>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
