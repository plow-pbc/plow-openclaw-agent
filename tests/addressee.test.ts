import assert from "node:assert/strict";
import { test } from "node:test";
import { addressedElsewhere } from "../plugin/addressee.ts";

// From Daniel's live group test (plow-openclaw-agent#123) and the 12-text battery: who each untagged text is for.
const members = ["Daniel", "+15550000002"];
for (const [text, elsewhere] of [
  // The leak: a chore for the partner, called by a pet name. It got "🥛".
  ["amor, don't forget to grab milk on the way home", true],
  ["Oi amor, cheguei!", true],
  ["Amor, o que você quer de jantar hoje?", true],
  ["Honey can you pick up the kids at 5?", true],
  ["babe, call the plumber before noon", true],
  ["Ok, drive safe amor", true],
  ["Te amo amor ❤️", true],
  ["thanks love", true],
  ["Camily, did you book the dentist?", true],
  ["Bom dia, Camily, tudo bem?", true],
  ["Daniel, call me later", true],
  // Says this agent's name: it is for the agent, or the model judges.
  ["Cypress, what's today's date?", false],
  ["Hey Cypress, how many minutes are in 3.5 hours?", false],
  ["cypress what's 7 times 8?", false],
  ["amor, ask Cypress what time works", false],
  // Calls nobody: the model judges (ambiguous asks, chat to the room).
  ["Anyone know what time the pharmacy closes?", false],
  ["Guys, can someone check the weather?", false],
  ["Alguém sabe se vai chover amanhã?", false],
  ["So, what now?", false],
  ["Hello, can someone help?", false],
  ["Who wants coffee?", false],
  // A chore with no name is the prompt's rule, not this guard's.
  ["don't forget to grab milk on the way home", false],
  ["", false],
] as const) test(`addressed elsewhere: ${JSON.stringify(text)} → ${elsewhere}`, () => {
  assert.equal(addressedElsewhere(text, "Cypress", members), elsewhere);
});

test("a member's own first name calls them anywhere a pet name would", () => {
  assert.equal(addressedElsewhere("see you at 8, Bia", "Cypress", ["Bia Souza"]), true);
  assert.equal(addressedElsewhere("see you at 8, Bia", "Cypress", []), false);
});

test("an agent with no configured name still keeps out of texts for someone else", () => {
  assert.equal(addressedElsewhere("amor, don't forget to grab milk", undefined), true);
  assert.equal(addressedElsewhere("what's 15% of 240?", undefined), false);
});
