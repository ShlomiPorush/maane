import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

// Component tests in happy-dom. End-to-end tests against the running stack live elsewhere (Playwright).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
