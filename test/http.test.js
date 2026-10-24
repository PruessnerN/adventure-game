const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");

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
      narrative: "You find a silver key beside the old map. The path leads toward a friendly village.",
      stateChanges: { healthDelta: -10, addItems: ["Silver key"], removeItems: ["Compass"] }
    }
  ];
  const ai = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    const answer = replies.shift();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  const aiPort = await listen(ai);
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "story-sprout-http-"));
  const portProbe = net.createServer();
  const appPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const app = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(appPort),
      DATABASE_PATH: path.join(testDirectory, "story.sqlite"),
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

  const createdResponse = await fetch(`${baseUrl}/api/worlds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: {
        setting: "Fantasy",
        characterKind: "Anthropomorphic animal",
        species: "Fox",
        archetype: "Ranger",
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

  const turnResponse = await fetch(`${baseUrl}/api/worlds/${created.id}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "I explore the forest" })
  });
  assert.equal(turnResponse.status, 200);
  const { world: afterTurn } = await turnResponse.json();
  assert.deepEqual(afterTurn.state.inventory, ["Silver key"]);
  assert.equal(afterTurn.state.health, 90);

  const eraseResponse = await fetch(`${baseUrl}/api/worlds/${created.id}/erase`, { method: "POST" });
  assert.equal(eraseResponse.status, 200);
  const { world: erased } = await eraseResponse.json();
  assert.deepEqual(erased.state.inventory, []);
  assert.equal(erased.state.health, 100);
  assert.equal(erased.turns.length, 0);
});
