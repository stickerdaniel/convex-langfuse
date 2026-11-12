import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Card, Field, TextInput, TextArea, Button } from "./ui";
import { withLog } from "../lib/logStore";

/** Ids of a recorded generation. */
export type Generation = { traceId: string; observationId: string };

export function LogGeneration(props: {
  userId: string;
  conversationId: string;
  onGeneration: (generation: Generation) => void;
}) {
  const [model, setModel] = useState("gpt-5");
  const [prompt, setPrompt] = useState("What is Convex?");
  const [completion, setCompletion] = useState(
    "Convex is a reactive backend platform: database, functions, and scheduling in one system.",
  );
  const [inputTokens, setInputTokens] = useState(12);
  const [outputTokens, setOutputTokens] = useState(28);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Generation | null>(null);

  const recordChatCompletion = useMutation(api.example.recordChatCompletion);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await withLog("recordChatCompletion", () =>
        recordChatCompletion({
          conversationId: props.conversationId,
          userId: props.userId,
          model,
          prompt,
          completion,
          inputTokens,
          outputTokens,
        }),
      );
      setLastResult(result);
      props.onGeneration(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Record a generation"
      description="A mutation saves the completion as a note and records it as a generation in the same transaction."
    >
      <Field label="Model">
        <TextInput value={model} onChange={(e) => setModel(e.target.value)} />
      </Field>
      <Field label="Prompt">
        <TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <Field label="Completion">
        <TextArea value={completion} onChange={(e) => setCompletion(e.target.value)} />
      </Field>
      <div className="row">
        <Field label="Input tokens">
          <TextInput
            type="number"
            value={inputTokens}
            onChange={(e) => setInputTokens(Number(e.target.value))}
          />
        </Field>
        <Field label="Output tokens">
          <TextInput
            type="number"
            value={outputTokens}
            onChange={(e) => setOutputTokens(Number(e.target.value))}
          />
        </Field>
      </div>
      <Button onClick={submit} disabled={busy}>
        {busy ? "Recording…" : "Record generation"}
      </Button>
      {error && <div className="error-text">{error}</div>}
      {lastResult && (
        <div className="trace-ref" style={{ marginTop: "1rem" }}>
          <span className="label">traceId</span>
          <span className="mono">{lastResult.traceId}</span>
        </div>
      )}
    </Card>
  );
}
