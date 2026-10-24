const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3003);
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, "data", "story-sprout.sqlite");
const AI_BASE_URL = (process.env.AI_BASE_URL || "http://192.168.0.48:33821/v1").replace(/\/+$/, "");
const AI_MODEL = process.env.AI_MODEL || "local-model";
const AI_API_KEY = process.env.AI_API_KEY;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 90000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 16_000;

const SETTINGS = ["Fantasy", "Science fiction", "Modern day", "Mythical animal kingdom"];
const GENDERS = ["Girl", "Boy", "Non-binary", "Prefer not to say"];
const SPECIES = ["Fox", "Cat", "Wolf", "Rabbit", "Bear", "Bird", "Dragon", "Other animal"];
const CLASS_OPTIONS = {
  Fantasy: ["Ranger", "Wizard", "Knight", "Healer", "Bard", "Inventor"],
  "Science fiction": ["Pilot", "Explorer", "Robot friend", "Scientist", "Space ranger", "Inventor"],
  "Modern day": ["Artist", "Athlete", "Detective", "Scientist", "Explorer", "Helper"],
  "Mythical animal kingdom": ["Forest guardian", "Sky flyer", "Clever trickster", "Healer", "Brave explorer", "Dragon rider"]
};

function isUnsafeText(text) {
  if (typeof text !== "string") return false;
  return /\b(?:porn(?:ography)?|nude|naked|sex(?:ual)?|erotic|xxx|fetish|gore|dismember(?:ment)?|rape|molest(?:ation)?|suicide|self[- ]harm)\b/i.test(text);
}

function validateWorldConfig(input) {
  if (!input || typeof input !== "object") throw new Error("World details are required.");
  const { setting, characterKind, species, archetype, gender, name } = input;
  if (!SETTINGS.includes(setting)) throw new Error("Choose one of the available world settings.");
  if (!["Human", "Anthropomorphic animal"].includes(characterKind)) throw new Error("Choose a character type.");
  if (characterKind === "Anthropomorphic animal" && !SPECIES.includes(species)) {
    throw new Error("Choose an available animal species.");
  }
  if (!CLASS_OPTIONS[setting].includes(archetype)) throw new Error("Choose an archetype for this setting.");
  if (!GENDERS.includes(gender)) throw new Error("Choose one of the available gender options.");
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 32) {
    throw new Error("Character name must be between 1 and 32 characters.");
  }
  if (isUnsafeText(name)) throw new Error("Please choose a different character name.");
  return {
    setting,
    characterKind,
    species: characterKind === "Anthropomorphic animal" ? species : null,
    archetype,
    gender,
    name: name.trim()
  };
}

function normalizeStateChanges(changes, narrative, currentState) {
  const next = { ...currentState, inventory: [...currentState.inventory] };
  if (!changes || typeof changes !== "object") return next;
  const delta = Number(changes.healthDelta);
  if (Number.isFinite(delta)) next.health = Math.max(0, Math.min(100, next.health + Math.trunc(delta)));
  const levelDelta = Number(changes.levelDelta);
  if (Number.isFinite(levelDelta)) next.level = Math.max(1, Math.min(99, next.level + Math.max(0, Math.min(1, Math.trunc(levelDelta)))));
  const goldDelta = Number(changes.goldDelta);
  if (Number.isFinite(goldDelta)) next.gold = Math.max(0, Math.min(999999, next.gold + Math.trunc(goldDelta)));

  if (Array.isArray(changes.addItems)) {
    for (const item of changes.addItems) {
      if (typeof item !== "string" || item.trim().length === 0 || item.trim().length > 48) continue;
      const cleanItem = item.trim();
      const escapedItem = cleanItem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const acquisition = new RegExp(`\\b(found|finds|find|picked up|picks up|received|receives|earned|earns|given|gets)\\b.{0,60}\\b${escapedItem}\\b`, "i");
      if (acquisition.test(narrative) &&
          !next.inventory.some(existing => existing.toLocaleLowerCase() === cleanItem.toLocaleLowerCase())) {
        next.inventory.push(cleanItem);
      }
    }
  }
  if (Array.isArray(changes.removeItems)) {
    for (const item of changes.removeItems) {
      if (typeof item !== "string") continue;
      const index = next.inventory.findIndex(existing => existing.toLocaleLowerCase() === item.trim().toLocaleLowerCase());
      if (index >= 0) next.inventory.splice(index, 1);
    }
  }
  return next;
}

function openDatabase() {
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  const db = new DatabaseSync(DATABASE_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      state TEXT NOT NULL,
      opening TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      response TEXT NOT NULL,
      state_before TEXT NOT NULL,
      state_after TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_world_id_id ON turns(world_id, id);
    CREATE TABLE IF NOT EXISTS ai_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT REFERENCES worlds(id) ON DELETE SET NULL,
      request_context TEXT NOT NULL,
      response_text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

const db = openDatabase();
const statements = {
  listWorlds: db.prepare("SELECT id, name, config, state, opening, created_at FROM worlds ORDER BY created_at DESC"),
  getWorld: db.prepare("SELECT id, name, config, state, opening, created_at FROM worlds WHERE id = ?"),
  createWorld: db.prepare("INSERT INTO worlds (id, name, config, state, opening, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  updateWorldState: db.prepare("UPDATE worlds SET state = ? WHERE id = ?"),
  deleteWorld: db.prepare("DELETE FROM worlds WHERE id = ?"),
  listTurns: db.prepare("SELECT id, action, response, state_before, state_after, created_at FROM turns WHERE world_id = ? ORDER BY id"),
  insertTurn: db.prepare("INSERT INTO turns (world_id, action, response, state_before, state_after, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  lastTurn: db.prepare("SELECT id, state_before FROM turns WHERE world_id = ? ORDER BY id DESC LIMIT 1"),
  deleteTurn: db.prepare("DELETE FROM turns WHERE id = ?"),
  startAI: db.prepare("INSERT INTO ai_logs (world_id, request_context, response_text, status, created_at) VALUES (?, ?, '', 'pending', ?)"),
  finishAI: db.prepare("UPDATE ai_logs SET world_id = ?, response_text = ?, status = ? WHERE id = ?")
};

function decodeWorld(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    config: JSON.parse(row.config),
    state: JSON.parse(row.state),
    opening: row.opening,
    createdAt: row.created_at
  };
}

function worldWithTurns(id) {
  const world = decodeWorld(statements.getWorld.get(id));
  if (!world) return null;
  world.turns = statements.listTurns.all(id).map(row => ({
    id: row.id,
    action: row.action,
    response: row.response,
    createdAt: row.created_at
  }));
  return world;
}

function startAILog(worldId, prompt) {
  return Number(statements.startAI.run(worldId, prompt, new Date().toISOString()).lastInsertRowid);
}

function finishAILog(logId, worldId, responseText, status) {
  statements.finishAI.run(worldId, responseText, status, logId);
}

function errorResponse(status, message) {
  return { status, body: { error: message } };
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function makeWorldPrompt(config, state) {
  const character = config.characterKind === "Human"
    ? `${config.name}, a ${config.gender.toLowerCase()} ${config.archetype.toLowerCase()}`
    : `${config.name}, an anthropomorphic ${config.species.toLowerCase()} who is a ${config.gender.toLowerCase()} ${config.archetype.toLowerCase()}`;
  return [
    "You are the gentle, imaginative narrator of a text adventure for children.",
    "Keep every response age-appropriate and safe for work. No sexual content, graphic violence, frightening gore, or dangerous real-world instructions.",
    "Use warm, accessible language. Keep peril mild and resolve danger in a reassuring way.",
    `World setting: ${config.setting}. Main character: ${character}.`,
    "Create a welcoming opening scene and a short backstory that invites the player into an adventure.",
    "The character has exactly the state provided below. Never imply they own, carry, or can use an item that is not in their inventory.",
    `Current state: ${JSON.stringify(state)}.`,
    "Return only a JSON object with keys: narrative (string), stateChanges (object with healthDelta, levelDelta, goldDelta, addItems, removeItems).",
    "For the opening, set all deltas to 0 and both item arrays to []."
  ].join("\n");
}

function makeTurnPrompt(world, turns, action) {
  const history = turns.slice(-8).map(turn => ({ action: turn.action, outcome: turn.response }));
  return [
    "You are the gentle, imaginative narrator of a text adventure for children.",
    "Keep every response age-appropriate and safe for work. No sexual content, graphic violence, frightening gore, or dangerous real-world instructions.",
    "Use warm, accessible language. Keep peril mild and resolve danger in a reassuring way.",
    `World and character: ${JSON.stringify(world.config)}.`,
    `Authoritative player state (do not contradict or invent inventory): ${JSON.stringify(world.state)}.`,
    `Recent story history: ${JSON.stringify(history)}.`,
    `Player action: ${action || "The player asks the story to continue with an interesting, gentle development."}`,
    "Continue the story in a few engaging paragraphs. Reflect the action and existing state. Do not claim the player has an item unless it is in the inventory or you explicitly narrate that they acquire it in this turn.",
    "Return only a JSON object with keys: narrative (string), stateChanges (object with healthDelta, levelDelta, goldDelta, addItems, removeItems).",
    "Use small, fair state changes. Only remove items that are actually in the inventory. Set every delta to 0 and both item arrays to [] if no change is warranted."
  ].join("\n");
}

async function generateStory(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(AI_API_KEY ? { Authorization: `Bearer ${AI_API_KEY}` } : {})
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "system", content: prompt }],
        temperature: 0.7
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") throw Object.assign(new Error("The story service took too long to respond. Please try again."), { status: 504 });
    throw Object.assign(new Error(`Could not reach the local story service at ${AI_BASE_URL}. Check its address and availability.`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw Object.assign(new Error(`The local story service returned ${response.status}${detail ? `: ${detail}` : ""}`), { status: 502 });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error("The local story service returned invalid JSON. Please check its configuration."), { status: 502 });
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw Object.assign(new Error("The local story service returned an unexpected response."), { status: 502 });
  let result;
  try {
    const jsonText = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    result = JSON.parse(jsonText);
  } catch {
    throw Object.assign(new Error("The local story service returned a response that could not be read. Please try again."), { status: 502 });
  }
  if (typeof result.narrative !== "string" || !result.narrative.trim()) {
    throw Object.assign(new Error("The local story service returned an empty story. Please try again."), { status: 502 });
  }
  return { narrative: result.narrative.trim(), stateChanges: result.stateChanges || {} };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, aiConfigured: Boolean(AI_BASE_URL) });
  }
  if (request.method === "GET" && url.pathname === "/api/worlds") {
    return sendJson(response, 200, { worlds: statements.listWorlds.all().map(decodeWorld) });
  }
  if (segments[0] === "api" && segments[1] === "worlds" && segments[2]) {
    const id = segments[2];
    const world = decodeWorld(statements.getWorld.get(id));
    if (!world) return sendJson(response, 404, { error: "That world could not be found." });

    if (request.method === "GET" && segments.length === 3) return sendJson(response, 200, { world: worldWithTurns(id) });
    if (request.method === "DELETE" && segments.length === 3) {
      statements.deleteWorld.run(id);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && segments[3] === "turn") {
      const body = await readJson(request);
      const action = body?.action === "continue" ? "" : body?.action;
      if (typeof action !== "string" || action.length > 1000) return sendJson(response, 400, { error: "Please enter an action under 1,000 characters." });
      if (action && !action.trim()) return sendJson(response, 400, { error: "Please describe what your character does." });
      if (isUnsafeText(action)) return sendJson(response, 422, { error: "That turn isn't suitable for this adventure. Please try a different, kid-friendly action." });
      const turns = statements.listTurns.all(id).map(row => ({ action: row.action, response: row.response }));
      const prompt = makeTurnPrompt(world, turns, action.trim());
      const logId = startAILog(id, prompt);
      let generated;
      try {
        generated = await generateStory(prompt);
      } catch (error) {
        finishAILog(logId, id, "[Generation failed]", `error:${error.status || 502}`);
        throw error;
      }
      if (isUnsafeText(generated.narrative)) {
        finishAILog(logId, id, "[Blocked by kid-safety check]", "blocked-output");
        return sendJson(response, 422, { error: "The story paused for a safety check. Please try your turn again." });
      }
      const stateBefore = JSON.stringify(world.state);
      const stateAfter = normalizeStateChanges(generated.stateChanges, generated.narrative, world.state);
      const safeAction = action.trim() || "Continue the story";
      const now = new Date().toISOString();
      db.exec("BEGIN");
      try {
        statements.insertTurn.run(id, safeAction, generated.narrative, stateBefore, JSON.stringify(stateAfter), now);
        statements.updateWorldState.run(JSON.stringify(stateAfter), id);
        finishAILog(logId, id, generated.narrative, "success");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return sendJson(response, 200, { world: worldWithTurns(id) });
    }
    if (request.method === "POST" && segments[3] === "erase") {
      const last = statements.lastTurn.get(id);
      if (!last) return sendJson(response, 409, { error: "There is no turn to erase yet." });
      db.exec("BEGIN");
      try {
        statements.deleteTurn.run(last.id);
        statements.updateWorldState.run(last.state_before, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return sendJson(response, 200, { world: worldWithTurns(id) });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/worlds") {
    const body = await readJson(request);
    let config;
    try {
      config = validateWorldConfig(body?.config);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
    const state = { health: 100, level: 1, gold: 0, inventory: [], relationships: {} };
    const prompt = makeWorldPrompt(config, state);
    const logId = startAILog(null, prompt);
    let generated;
    try {
      generated = await generateStory(prompt);
    } catch (error) {
      finishAILog(logId, null, "[Generation failed]", `error:${error.status || 502}`);
      throw error;
    }
    if (isUnsafeText(generated.narrative)) {
      finishAILog(logId, null, "[Blocked by kid-safety check]", "blocked-output");
      return sendJson(response, 502, { error: "The story service's response did not pass the safety check. Please try again." });
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const finalState = state;
    db.exec("BEGIN");
    try {
      statements.createWorld.run(id, config.name, JSON.stringify(config), JSON.stringify(finalState), generated.narrative, now);
      finishAILog(logId, id, generated.narrative, "success");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return sendJson(response, 201, { world: worldWithTurns(id) });
  }

  if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
    const filePath = url.pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, path.normalize(url.pathname));
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
      return sendJson(response, 404, { error: "Not found." });
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return sendJson(response, 404, { error: "Not found." });
    }
    if (!stat.isFile()) return sendJson(response, 404, { error: "Not found." });
    const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    return fs.createReadStream(filePath).pipe(response);
  }
  return sendJson(response, 404, { error: "Not found." });
}

const server = http.createServer((request, response) => {
  route(request, response).catch(error => {
    console.error(`[${new Date().toISOString()}] ${request.method} ${request.url}:`, error);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : "Something went wrong. Please try again." });
    else response.end();
  });
});

function shutdownServer(httpServer, database, processHandle = process, gracePeriodMs = 10000) {
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; finishing active requests before shutdown.`);
    const forceCloseTimer = setTimeout(() => {
      console.error("Shutdown grace period expired; closing remaining connections.");
      httpServer.closeAllConnections();
    }, gracePeriodMs);
    httpServer.close(error => {
      clearTimeout(forceCloseTimer);
      if (error) {
        console.error("Unable to close the story server cleanly.", error);
        processHandle.exitCode = 1;
      } else {
        try {
          database.close();
          console.log("Story server stopped cleanly.");
        } catch (closeError) {
          console.error("Unable to close the story database cleanly.", closeError);
          processHandle.exitCode = 1;
        }
      }
    });
    httpServer.closeIdleConnections();
  }

  processHandle.once("SIGTERM", () => shutdown("SIGTERM"));
  processHandle.once("SIGINT", () => shutdown("SIGINT"));
  return shutdown;
}

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => console.log(`Story Sprout listening on port ${PORT}`));
  shutdownServer(server, db);
}

module.exports = { isUnsafeText, validateWorldConfig, normalizeStateChanges, makeTurnPrompt, shutdownServer };
