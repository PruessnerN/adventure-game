const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("world creation, turn updates, and erasing restore authoritative state", async t => {
  const replies = [
    {
      narrative: "A sunlit forest welcomes Clover, a thoughtful fox ranger.",
      stateChanges: { healthDelta: -50, addItems: ["Magic sword"] }
    },
    {
      narrative: "The stone catches Clover, dealing 10 damage. You find a silver key beside the old map. The path leads toward a friendly village.",
      stateChanges: {}
    },
    {
      narrative: "Hannah's hero discovers a bright little lantern in a quiet cave.",
      stateChanges: {}
    }
  ];
  const aiRequests = [];
  const ai = http.createServer(async (request, response) => {
    let requestBody = "";
    for await (const chunk of request) requestBody += chunk;
    const parsedRequest = JSON.parse(requestBody);
    aiRequests.push(parsedRequest);
    const requestContent = parsedRequest.messages.map(message => message.content).join("\n");
    const isSummaryRequest = requestContent.includes("Summarize previous adventure history");
    const isStateReview = requestContent.includes("state-change extractor") ||
      requestContent.includes("Return strict JSON with exactly these keys: healthDelta");
    const answer = isSummaryRequest
      ? "Clover is exploring the forest, found a silver key, and is heading toward a village."
      : isStateReview
        ? {
          healthDelta: { value: -10, evidence: "The stone catches Clover, dealing 10 damage." },
          levelDelta: { value: 0, evidence: "" },
          goldDelta: { value: 0, evidence: "" },
          addItems: [{ name: "Silver key", evidence: "You find a silver key beside the old map." }],
          removeItems: []
        }
        : replies.shift();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: isSummaryRequest ? answer : JSON.stringify(answer) } }] }));
  });
  const aiPort = await listen(ai);
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "story-sprout-http-"));
  const databasePath = path.join(testDirectory, "story.sqlite");
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    CREATE TABLE worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      state TEXT NOT NULL,
      opening TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  legacyDb.prepare("INSERT INTO worlds (id, name, config, state, opening, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("legacy-world", "Franklyn", "{}", JSON.stringify({ health: 100, level: 1, gold: 0, inventory: [], relationships: {} }), "An older saved adventure.", "2026-10-24T16:00:00.000Z");
  legacyDb.close();
  const portProbe = net.createServer();
  const appPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const app = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(appPort),
      DATABASE_PATH: databasePath,
      AI_BASE_URL: `http://127.0.0.1:${aiPort}/v1`,
      AI_MODEL: "test-model"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let appOutput = "";
  app.stdout.on("data", chunk => appOutput += chunk);
  app.stderr.on("data", chunk => appOutput += chunk);
  t.after(async () => {
    const exited = new Promise(resolve => app.once("exit", resolve));
    app.kill("SIGTERM");
    await exited;
    assert.match(appOutput, /Story server stopped cleanly\./);
    await new Promise(resolve => ai.close(resolve));
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${appPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* app is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `app did not start: ${appOutput}`);

  const noProfile = await fetch(`${baseUrl}/api/worlds`);
  assert.equal(noProfile.status, 401);
  const nateHeaders = { "Content-Type": "application/json", "X-Player-Name": "Nate" };
  const hannahHeaders = { "Content-Type": "application/json", "X-Player-Name": "Hannah" };
  const malformedJsonResponse = await fetch(`${baseUrl}/api/worlds`, {
    method: "POST",
    headers: nateHeaders,
    body: '{"config":'
  });
  assert.equal(malformedJsonResponse.status, 400);
  const malformedJson = await malformedJsonResponse.json();
  assert.equal(malformedJson.code, "INVALID_REQUEST");
  assert.match(malformedJson.requestId, /^[0-9a-f-]{36}$/i);

  const initialNateWorlds = await fetch(`${baseUrl}/api/worlds`, { headers: nateHeaders });
  const initialNateData = await initialNateWorlds.json();
  assert.deepEqual(initialNateData.worlds.map(world => world.name), ["Franklyn"]);

  const createdResponse = await fetch(`${baseUrl}/api/worlds`, {
    method: "POST",
    headers: nateHeaders,
    body: JSON.stringify({
      config: {
        setting: "Mythical animal kingdom",
        race: "Fox",
        archetype: "Forest guardian",
        gender: "Non-binary",
        name: "Clover"
      }
    })
  });
  assert.equal(createdResponse.status, 201);
  const { world: created } = await createdResponse.json();
  assert.deepEqual(created.state.inventory, []);
  assert.equal(created.state.health, 100);
  assert.equal(created.turns.length, 0);
  assert.equal(aiRequests[0].max_tokens, undefined);
  assert.deepEqual(aiRequests[0].response_format, { type: "json_object" });
  assert.deepEqual(aiRequests[0].chat_template_kwargs, { reasoning_effort: "low" });

  const turnResponse = await fetch(`${baseUrl}/api/worlds/${created.id}/turn`, {
    method: "POST",
    headers: nateHeaders,
    body: JSON.stringify({ action: "I explore the forest" })
  });
  assert.equal(turnResponse.status, 200);
  const { world: afterTurn } = await turnResponse.json();
  assert.deepEqual(afterTurn.state.inventory, ["Silver key"]);
  assert.equal(afterTurn.state.health, 90);
  assert.equal(aiRequests.length, 4);
  assert.equal(aiRequests[1].max_tokens, undefined);
  assert.equal(aiRequests[1].temperature, 0.2);
  assert.equal(aiRequests[1].response_format, undefined);
  assert.deepEqual(aiRequests[1].chat_template_kwargs, { enable_thinking: false });
  assert.equal(aiRequests[2].max_tokens, undefined);
  assert.deepEqual(aiRequests[2].response_format, { type: "json_object" });
  assert.deepEqual(aiRequests[2].chat_template_kwargs, { reasoning_effort: "low" });
  assert.equal(aiRequests[3].max_tokens, undefined);
  assert.equal(aiRequests[3].temperature, 0);
  assert.deepEqual(aiRequests[3].response_format, { type: "json_object" });
  assert.deepEqual(aiRequests[3].chat_template_kwargs, { enable_thinking: false });
  assert.match(aiRequests[1].messages[1].content, /Opening scene: A sunlit forest welcomes Clover/);
  assert.match(aiRequests[2].messages[0].content, /Clover is exploring the forest, found a silver key/);
  assert.match(aiRequests[2].messages[0].content, /Last 0 action-response pairs/);
  assert.match(aiRequests[2].messages[0].content, /I explore the forest/);
  assert.match(aiRequests[3].messages[1].content, /Current authoritative state/);
  assert.match(aiRequests[3].messages[1].content, /silver key beside the old map/);

  const eraseResponse = await fetch(`${baseUrl}/api/worlds/${created.id}/erase`, { method: "POST", headers: nateHeaders });
  assert.equal(eraseResponse.status, 200);
  const { world: erased } = await eraseResponse.json();
  assert.deepEqual(erased.state.inventory, []);
  assert.equal(erased.state.health, 100);
  assert.equal(erased.turns.length, 0);

  const hannahCreatedResponse = await fetch(`${baseUrl}/api/worlds`, {
    method: "POST",
    headers: hannahHeaders,
    body: JSON.stringify({
      config: {
        setting: "Fantasy",
        race: "Human",
        archetype: "Healer",
        gender: "Girl",
        name: "Hannah's Hero"
      }
    })
  });
  assert.equal(hannahCreatedResponse.status, 201);
  const { world: hannahWorld } = await hannahCreatedResponse.json();

  const nateWorldsResponse = await fetch(`${baseUrl}/api/worlds`, { headers: nateHeaders });
  const { worlds: nateWorlds } = await nateWorldsResponse.json();
  assert.deepEqual(nateWorlds.map(world => world.name).sort(), ["Clover", "Franklyn"]);
  const hannahWorldsResponse = await fetch(`${baseUrl}/api/worlds`, { headers: hannahHeaders });
  const { worlds: hannahWorlds } = await hannahWorldsResponse.json();
  assert.deepEqual(hannahWorlds.map(world => world.name), ["Hannah's Hero"]);

  const crossProfileRead = await fetch(`${baseUrl}/api/worlds/${created.id}`, { headers: hannahHeaders });
  assert.equal(crossProfileRead.status, 404);
  const crossProfileDelete = await fetch(`${baseUrl}/api/worlds/${hannahWorld.id}`, { method: "DELETE", headers: nateHeaders });
  assert.equal(crossProfileDelete.status, 404);
  assert.equal(aiRequests.length, 5);

  const corruptDb = new DatabaseSync(databasePath);
  corruptDb.prepare("UPDATE worlds SET config = ? WHERE id = ?").run("{", "legacy-world");
  corruptDb.close();
  const unexpectedErrorResponse = await fetch(`${baseUrl}/api/worlds`, { headers: nateHeaders });
  assert.equal(unexpectedErrorResponse.status, 500);
  const unexpectedError = await unexpectedErrorResponse.json();
  assert.equal(unexpectedError.code, "INTERNAL_ERROR");
  assert.match(unexpectedError.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(unexpectedError.error, "Something went wrong on the server. Please try again.");
});
