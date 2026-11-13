// Values PostgreSQL cannot store (plan 2.3, P21, P22): the rule lives in the server (text.ts), so the replies an agent
// writes (plan 3.1) and intake pass through the same function.

export { wellFormed, wellFormedText } from "@maane/server/text"
