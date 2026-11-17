import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Locally, tests read DATABASE_URL from .env; in CI the workflow sets it.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({});
