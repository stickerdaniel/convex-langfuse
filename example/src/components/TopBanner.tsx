import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function TopBanner() {
  const dashboardUrl = useQuery(api.example.getDashboardUrl);

  return (
    <div className="banner">
      This example exports to Langfuse once <code>LANGFUSE_PUBLIC_KEY</code>,{" "}
      <code>LANGFUSE_SECRET_KEY</code> and <code>LANGFUSE_BASE_URL</code> are set with{" "}
      <code>npx convex env set</code>.{" "}
      {dashboardUrl && (
        <>
          Traces recorded here show up at{" "}
          <a href={dashboardUrl} target="_blank" rel="noreferrer">
            {dashboardUrl}
          </a>
          .
        </>
      )}
    </div>
  );
}
