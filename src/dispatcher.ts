import "./config.js"; // validates the environment before anything starts

// Stub (PHX-010): the outbox loop arrives in PHX-032.
console.log("dispatcher started (stub)");
setInterval(() => {}, 60_000); // keep the process alive
