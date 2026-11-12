import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("retention sweep", { hours: 1 }, internal.retention.sweep, {});
crons.interval(
  "score config resync",
  { hours: 1 },
  internal.scores.resyncTick,
  {},
);

export default crons;
