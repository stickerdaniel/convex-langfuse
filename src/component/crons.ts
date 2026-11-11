import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("retention sweep", { hours: 1 }, internal.retention.sweep, {});

export default crons;
