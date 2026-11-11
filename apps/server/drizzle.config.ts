import { defineConfig } from "drizzle-kit"

// Generates SQL migrations from src/db/schema.ts into drizzle/. No database connection: generation only.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
})
