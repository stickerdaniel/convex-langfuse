// Test-only component functions for tests whose root is an app, which
// cannot read the component's tables directly. Convex skips files with more
// than one dot in the name, so these are never deployed.

import { internalMutation, internalQuery } from "./_generated/server.js";

/** Every document of the component's export tables. */
export const exportTables = internalQuery({
  args: {},
  handler: async (ctx) => ({
    outbox: await ctx.db.query("outbox").collect(),
    payloads: await ctx.db.query("payloads").collect(),
    deadLetters: await ctx.db.query("deadLetters").collect(),
    exporter: await ctx.db.query("exporter").collect(),
    gate: await ctx.db.query("gate").collect(),
  }),
});

/** Closes the admission gate, as a full backlog would. */
export const closeGate = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("gate", { accepting: false, changedAt: Date.now() });
  },
});
