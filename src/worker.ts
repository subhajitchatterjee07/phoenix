import { hostname } from "node:os";
import "./config.js"; // validates the environment before anything starts

// Stub (PHX-010): the claim → run → release loop arrives in PHX-014.
console.log(`worker ${hostname()} started (stub)`);
setInterval(() => {}, 60_000); // keep the process alive
