import { simulateVerification } from "../lib/development-verification-simulation.mjs";

if (process.env.NODE_ENV === "production") throw new Error("simulate_verification is unavailable in production");
const result = await simulateVerification();
console.log(JSON.stringify({
  status: result.status,
  completed: result.completed.length,
  humanEvents: result.humanEvents,
  worker3Submissions: result.assignments.filter((item) => item.workerId === "doubao-worker-3").length,
  startsChromium: result.startsChromium,
  writesToPersistentStore: result.writesToPersistentStore,
}, null, 2));
