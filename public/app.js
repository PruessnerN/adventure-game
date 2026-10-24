const SETTINGS = ["Fantasy", "Science fiction", "Modern day", "Mythical animal kingdom"];
const CLASS_OPTIONS = {
  Fantasy: ["Ranger", "Wizard", "Knight", "Healer", "Bard", "Inventor"],
  "Science fiction": ["Pilot", "Explorer", "Robot friend", "Scientist", "Space ranger", "Inventor"],
  "Modern day": ["Artist", "Athlete", "Detective", "Scientist", "Explorer", "Helper"],
  "Mythical animal kingdom": ["Forest guardian", "Sky flyer", "Clever trickster", "Healer", "Brave explorer", "Dragon rider"]
};
const STEPS = [
  { key: "setting", title: "Where does your story happen?", hint: "Choose the kind of world you'd like to explore.", options: SETTINGS },
  { key: "characterKind", title: "Who will you be?", hint: "You can be a person or a talking animal hero.", options: ["Human", "Anthropomorphic animal"] },
  { key: "species", title: "What kind of animal are you?", hint: "Pick your animal hero's species.", options: ["Fox", "Cat", "Wolf", "Rabbit", "Bear", "Bird", "Dragon", "Other animal"], conditional: data => data.characterKind === "Anthropomorphic animal" },
  { key: "archetype", title: "What kind of hero are you?", hint: "Your role helps shape the adventures you'll find.", dynamic: data => CLASS_OPTIONS[data.setting] || [] },
  { key: "gender", title: "How do you describe your character?", hint: "Choose what feels right for your hero.", options: ["Girl", "Boy", "Non-binary", "Prefer not to say"] },
  { key: "name", title: "What is your hero's name?", hint: "Make it yours! You can use up to 32 characters." }
];
const config = { setting: null, characterKind: null, species: null, archetype: null, gender: null, name: "" };
let stepIndex = 0;
let worlds = [];
let activeWorld = null;
let busy = false;
let toastTimer;

const $ = id => document.getElementById(id);
const views = { welcome: $("welcome-view"), setup: $("setup-view"), game: $("game-view") };

function showView(viewName) {
  Object.entries(views).forEach(([name, element]) => element.classList.toggle("hidden", name !== viewName));
  $("crumb-name").textContent = viewName === "game" && activeWorld ? activeWorld.name.toUpperCase() : viewName === "setup" ? "NEW WORLD" : "WELCOME";
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function setBusy(value, title = "Growing your story...") {
  busy = value;
  $("loading-title").textContent = title;
  $("loading-overlay").classList.toggle("hidden", !value);
  document.querySelectorAll("button").forEach(button => button.disabled = value);
  $("action-input").disabled = value;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body;
}

function renderWorldList() {
  $("world-count").textContent = worlds.length;
  const list = $("world-list");
  list.replaceChildren();
  worlds.forEach(world => {
    const button = document.createElement("button");
    button.className = `world-link${activeWorld?.id === world.id ? " active" : ""}`;
    button.innerHTML = `<span>✿</span>${escapeHtml(world.name)}`;
    button.addEventListener("click", () => loadWorld(world.id));
    list.append(button);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function startSetup() {
  Object.keys(config).forEach(key => config[key] = key === "name" ? "" : null);
  stepIndex = 0;
  renderStep();
  showView("setup");
}

function currentSteps() {
  return STEPS.filter(step => !step.conditional || step.conditional(config));
}

function renderStep() {
  const steps = currentSteps();
  stepIndex = Math.min(stepIndex, steps.length - 1);
  const step = steps[stepIndex];
  const card = $("setup-form");
  card.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = step.title;
  const hint = document.createElement("p");
  hint.textContent = step.hint;
  card.append(title, hint);
  if (step.key === "name") {
    const input = document.createElement("input");
    input.id = "hero-name";
    input.className = "name-input";
    input.maxLength = 32;
    input.placeholder = "e.g. Rowan";
    input.value = config.name;
    input.autocomplete = "off";
    input.addEventListener("input", () => config.name = input.value);
    card.append(input);
    setTimeout(() => input.focus(), 0);
  } else {
    const options = step.dynamic ? step.dynamic(config) : step.options;
    const grid = document.createElement("div");
    grid.className = "choice-grid";
    options.forEach(option => {
      const button = document.createElement("button");
      button.className = `choice-card${config[step.key] === option ? " selected" : ""}`;
      button.type = "button";
      button.textContent = option;
      button.addEventListener("click", () => {
        config[step.key] = option;
        if (step.key === "setting") config.archetype = null;
        if (step.key === "characterKind" && option === "Human") config.species = null;
        renderStep();
      });
      grid.append(button);
    });
    card.append(grid);
  }
  $("step-count").textContent = `STEP ${stepIndex + 1} OF ${steps.length}`;
  $("step-progress-fill").style.width = `${(stepIndex + 1) / steps.length * 100}%`;
  $("step-back").style.visibility = stepIndex === 0 ? "hidden" : "visible";
  $("step-next").innerHTML = stepIndex === steps.length - 1 ? "Create my world <span>✦</span>" : "Next <span>→</span>";
  $("setup-error").textContent = "";
}

async function advanceSetup() {
  const steps = currentSteps();
  const step = steps[stepIndex];
  if (step.key === "name" && !config.name.trim()) {
    $("setup-error").textContent = "Give your hero a name to continue.";
    $("hero-name").focus();
    return;
  }
  if (step.key !== "name" && !config[step.key]) {
    $("setup-error").textContent = "Choose an answer to continue.";
    return;
  }
  if (stepIndex < steps.length - 1) {
    stepIndex++;
    renderStep();
    return;
  }
  setBusy(true, "Creating your world...");
  try {
    const { world } = await api("/api/worlds", { method: "POST", body: JSON.stringify({ config }) });
    activeWorld = world;
    await refreshWorlds();
    renderGame();
    showView("game");
  } catch (error) {
    $("setup-error").textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function refreshWorlds() {
  const data = await api("/api/worlds");
  worlds = data.worlds;
  renderWorldList();
}

async function loadWorld(id) {
  try {
    const data = await api(`/api/worlds/${encodeURIComponent(id)}`);
    activeWorld = data.world;
    renderWorldList();
    renderGame();
    showView("game");
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderGame() {
  if (!activeWorld) return;
  const { config: hero, state } = activeWorld;
  $("game-title").textContent = `${hero.name}'s adventure`;
  $("world-setting").textContent = hero.setting;
  $("character-line").textContent = hero.characterKind === "Human"
    ? `${hero.gender} ${hero.archetype}`
    : `${hero.gender} ${hero.species} · ${hero.archetype}`;
  $("opening-text").textContent = activeWorld.opening;
  $("panel-name").textContent = hero.name;
  $("panel-subtitle").textContent = hero.characterKind === "Human" ? hero.archetype : `${hero.species} · ${hero.archetype}`;
  $("hero-badge").textContent = hero.characterKind === "Human" ? "✦" : hero.species === "Fox" ? "♧" : "✿";
  $("health-value").textContent = state.health;
  $("health-bar").style.width = `${state.health}%`;
  $("level-value").textContent = state.level;
  $("gold-value").textContent = state.gold;
  $("panel-setting").textContent = hero.setting;
  $("inventory-count").textContent = state.inventory.length;
  const inventory = $("inventory-list");
  inventory.replaceChildren();
  if (!state.inventory.length) {
    const empty = document.createElement("div");
    empty.className = "empty-inventory";
    empty.innerHTML = "Nothing packed yet.<br>Your adventure is just beginning!";
    inventory.append(empty);
  } else {
    state.inventory.forEach(item => {
      const node = document.createElement("div");
      node.className = "inventory-item";
      node.textContent = item;
      inventory.append(node);
    });
  }
  const list = $("turn-list");
  list.replaceChildren();
  activeWorld.turns.forEach(turn => {
    const entry = document.createElement("article");
    entry.className = "turn-entry";
    const action = document.createElement("div");
    action.className = "turn-action";
    const icon = document.createElement("span");
    icon.textContent = turn.action === "Continue the story" ? "✧" : "✎";
    const label = document.createElement("b");
    label.textContent = turn.action === "Continue the story" ? "The story continues" : `${hero.name} ${turn.action}`;
    action.append(icon, label);
    const response = document.createElement("p");
    response.className = "turn-response";
    response.textContent = turn.response;
    entry.append(action, response);
    list.append(entry);
  });
  $("erase-turn").disabled = activeWorld.turns.length === 0;
  $("story-scroll").scrollTop = $("story-scroll").scrollHeight;
}

async function takeAction(action) {
  if (busy || !activeWorld) return;
  setBusy(true, action ? "Weaving your turn into the story..." : "Finding out what happens next...");
  try {
    const { world } = await api(`/api/worlds/${encodeURIComponent(activeWorld.id)}/turn`, {
      method: "POST",
      body: JSON.stringify({ action })
    });
    activeWorld = world;
    renderGame();
    await refreshWorlds();
    $("action-entry").classList.add("hidden");
    $("action-input").value = "";
    $("character-count").textContent = "0 / 1,000";
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function eraseLastTurn() {
  if (busy || !activeWorld || !activeWorld.turns.length) return;
  setBusy(true, "Rewinding one moment...");
  try {
    const { world } = await api(`/api/worlds/${encodeURIComponent(activeWorld.id)}/erase`, { method: "POST", body: "{}" });
    activeWorld = world;
    renderGame();
    await refreshWorlds();
    showToast("Last turn erased. Your story is ready to try again.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function deleteWorld() {
  if (!activeWorld || !window.confirm(`Delete "${activeWorld.name}" and its entire story? This cannot be undone.`)) return;
  try {
    await api(`/api/worlds/${encodeURIComponent(activeWorld.id)}`, { method: "DELETE" });
    activeWorld = null;
    await refreshWorlds();
    showView(worlds.length ? "welcome" : "welcome");
    showToast("World deleted.");
  } catch (error) {
    showToast(error.message, true);
  }
}

$("start-create").addEventListener("click", startSetup);
$("side-new").addEventListener("click", startSetup);
$("step-next").addEventListener("click", advanceSetup);
$("step-back").addEventListener("click", () => { if (stepIndex > 0) { stepIndex--; renderStep(); } });
$("take-turn").addEventListener("click", () => {
  $("action-entry").classList.remove("hidden");
  $("action-input").focus();
});
$("continue-story").addEventListener("click", () => takeAction(""));
$("submit-action").addEventListener("click", () => {
  const action = $("action-input").value.trim();
  if (!action) { showToast("Write what your hero does first.", true); $("action-input").focus(); return; }
  takeAction(action);
});
$("action-input").addEventListener("input", event => $("character-count").textContent = `${event.target.value.length} / 1,000`);
$("action-input").addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) $("submit-action").click();
});
$("erase-turn").addEventListener("click", eraseLastTurn);
$("delete-world").addEventListener("click", deleteWorld);

refreshWorlds().then(() => {
  if (!worlds.length) showView("welcome");
}).catch(error => showToast(error.message, true));
