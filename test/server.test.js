const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "story-sprout-unit-"));
process.env.DATABASE_PATH = path.join(testDirectory, "test.sqlite");
const { isUnsafeText, validateWorldConfig, normalizeStateChanges, makeTurnPrompt } = require("../server");
test.after(() => fs.rmSync(testDirectory, { recursive: true, force: true }));

test("world creation validates setting-specific options and character details", () => {
  const config = validateWorldConfig({
    setting: "Fantasy",
    characterKind: "Anthropomorphic animal",
    species: "Fox",
    archetype: "Ranger",
    gender: "Non-binary",
    name: "Clover"
  });
  assert.equal(config.species, "Fox");
  assert.equal(config.name, "Clover");
  assert.throws(() => validateWorldConfig({ ...config, archetype: "Pilot" }), /archetype/);
});

test("world creation requires a species for animal heroes and trims names", () => {
  const base = { setting: "Modern day", characterKind: "Human", archetype: "Artist", gender: "Girl", name: "  Rowan  " };
  assert.equal(validateWorldConfig(base).name, "Rowan");
  assert.throws(() => validateWorldConfig({ ...base, characterKind: "Anthropomorphic animal" }), /species/);
});

test("unsafe text is flagged for both player inputs and generated text", () => {
  assert.equal(isUnsafeText("I want to make a cozy garden"), false);
  assert.equal(isUnsafeText("Write an erotic scene"), true);
});

test("state updates clamp values and never add unowned items without acquisition in the story", () => {
  const initial = { health: 90, level: 1, gold: 2, inventory: ["Compass"], relationships: {} };
  const result = normalizeStateChanges({
    healthDelta: -200,
    levelDelta: 20,
    goldDelta: -10,
    addItems: ["Silver key", "Imaginary sword"],
    removeItems: ["Compass", "Unknown"]
  }, "A silver key appears in the old chest.", initial);
  assert.equal(result.health, 0);
  assert.equal(result.level, 2);
  assert.equal(result.gold, 0);
  assert.deepEqual(result.inventory, []);
  const acquired = normalizeStateChanges({
    addItems: ["Silver key"],
    removeItems: []
  }, "You find a silver key tucked beside the map.", initial);
  assert.deepEqual(acquired.inventory, ["Compass", "Silver key"]);
});

test("turn prompt includes authoritative player state and the requested action", () => {
  const prompt = makeTurnPrompt({
    config: { name: "Clover", setting: "Fantasy" },
    state: { health: 100, level: 1, inventory: ["Map"] }
  }, [], "I follow the trail");
  assert.match(prompt, /"Map"/);
  assert.match(prompt, /I follow the trail/);
});
