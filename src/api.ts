import Fastify from "fastify";
import "./config.js"; // validates the environment before anything starts

// Stub (PHX-010): listens on 8000 with no routes; the real API arrives in PHX-043.
const app = Fastify();
await app.listen({ host: "0.0.0.0", port: 8000 });
console.log("api listening on 8000 (stub: no routes yet)");
