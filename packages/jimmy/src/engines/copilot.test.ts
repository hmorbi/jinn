import test from "node:test";
import assert from "node:assert/strict";
import { CopilotEngine } from "./copilot.js";

// Access private methods via prototype for testing
const engine = new CopilotEngine();

test("CopilotEngine.name is 'copilot'", () => {
  assert.equal(engine.name, "copilot");
});

test("CopilotEngine.isAlive returns false for unknown session", () => {
  assert.equal(engine.isAlive("nonexistent-session"), false);
});

test("CopilotEngine.kill does not throw for unknown session", () => {
  // Should be a no-op, not throw
  engine.kill("nonexistent-session", "test reason");
});

test("CopilotEngine.killAll does not throw when no live processes", () => {
  engine.killAll();
});
