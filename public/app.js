const SETTINGS = ["Fantasy", "Science fiction", "Modern day", "Mythical animal kingdom"];
const CLASS_OPTIONS = {
  Fantasy: ["Ranger", "Wizard", "Knight", "Healer", "Bard", "Inventor"],
  "Science fiction": ["Pilot", "Explorer", "Robot friend", "Scientist", "Space ranger", "Inventor"],
  "Modern day": ["Artist", "Athlete", "Detective", "Scientist", "Explorer", "Helper"],
  "Mythical animal kingdom": ["Forest guardian", "Sky flyer", "Clever trickster", "Healer", "Brave explorer", "Dragon rider"]
};
const RACE_OPTIONS = {
  Fantasy: ["Human", "Elf", "Dwarf", "Goblin", "Orc", "Halfling", "Gnome", "Tiefling", "Dragonkin", "Fae"],
  "Science fiction": ["Human", "Android", "Cyborg", "Martian", "Aquatic alien", "Insectoid", "Reptilian", "Starborn", "Lunar settler", "Synthetic lifeform"],
  "Modern day": ["Human"],
  "Mythical animal kingdom": ["Badger", "Bear", "Bird", "Boar", "Cat", "Deer", "Dog", "Dragon", "Fox", "Frog", "Hare", "Hedgehog", "Horse", "Lizard", "Mouse", "Otter", "Owl", "Raccoon", "Raven", "Salamander", "Snake", "Turtle", "Wolf"]
};
const VALID_PLAYERS = ["Nate", "Hannah", "Hudson", "William"];
const STEPS = [
  { key: "setting", title: "Where does your story happen?", hint: "Choose the kind of world you'd like to explore.", options: SETTINGS },
  { key: "race", title: "What race are you?", hint: "Choose a race that belongs in your setting.", dynamic: data => RACE_OPTIONS[data.setting] || [] },
  { key: "archetype", title: "What kind of hero are you?", hint: "Your role helps shape the adventures you'll find.", dynamic: data => CLASS_OPTIONS[data.setting] || [] },
  { key: "gender", title: "How do you describe your character?", hint: "Choose what feels right for your hero.", options: ["Girl", "Boy", "Non-binary", "Prefer not to say"] },
  { key: "name", title: "What is your hero's name?", hint: "Make it yours! You can use up to 32 characters." },
  { key: "description", title: "Add a little more detail", hint: "Optionally describe your world and your hero's role in it.", optional: true }
];
const config = { setting: null, race: null, archetype: null, gender: null, name: "", description: "" };
let stepIndex = 0;
let worlds = [];
let activeWorld = null;
let activePlayer = null;
let busy = false;
let toastTimer;
const notifiedErrors = new WeakSet();

const $ = id => document.getElementById(id);
const views = { player: $("player-view"), welcome: $("welcome-view"), setup: $("setup-view"), game: $("game-view") };

const toastService = {
  show(message, type = "error", error = null) {
    if (error && typeof error === "object") {
      if (notifiedErrors.has(error)) return;
      notifiedErrors.add(error);
    }
    const toast = $("toast");
    const messageElement = $("toast-message");
    messageElement.textContent = message;
    $("toast-mark").textContent = type === "error" ? "!" : "✓";
    toast.classList.toggle("error", type === "error");
    toast.classList.toggle("success", type === "success");
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), type === "error" ? 8000 : 3500);
  },
  showError(error) {
    const message = error instanceof Error ? error.message : String(error || "Something went wrong. Please try again.");
    this.show(message, "error", error instanceof Error ? error : null);
  },
  dismiss() {
    $("toast").classList.remove("visible");
    clearTimeout(toastTimer);
  }
};

function showView(viewName) {
  Object.entries(views).forEach(([name, element]) => element.classList.toggle("hidden", name !== viewName));
  $("crumb-name").textContent = viewName === "game" && activeWorld ? activeWorld.name.toUpperCase() : viewName === "setup" ? "NEW WORLD" : viewName === "player" ? "CHOOSE PLAYER" : "WELCOME";
}

function showToast(message, isError = false) {
  toastService.show(message, isError ? "error" : "success");
}

function setBusy(value, title = "Growing your story...") {
  busy = value;
  $("step-next").disabled = value;
  $("step-back").disabled = value;
  $("submit-action").disabled = value;
  $("take-turn").disabled = value;
  $("continue-story").disabled = value;
  $("erase-turn").disabled = value || !activeWorld?.turns.length;
  $("delete-world").disabled = value;
  $("side-new").disabled = value;
  $("start-create").disabled = value;
  $("switch-player").disabled = value;
  document.querySelectorAll(".world-link").forEach(button => button.disabled = value);
  $("action-input").disabled = value;
  $("setup-pending").classList.toggle("hidden", !value || Boolean(activeWorld));
  $("setup-pending-text").textContent = title;
}

function showPendingStory(text) {
  const list = $("turn-list");
  $("pending-story")?.remove();
  const entry = document.createElement("article");
  entry.id = "pending-story";
  entry.className = "turn-entry pending-story";
  entry.setAttribute("role", "status");
  entry.setAttribute("aria-live", "polite");
  const label = document.createElement("div");
  label.className = "turn-action";
  label.textContent = text;
  const paragraph = document.createElement("p");
  paragraph.className = "turn-response skeleton-paragraph";
  paragraph.setAttribute("aria-label", text);
  for (let index = 0; index < 3; index++) {
    const line = document.createElement("span");
    line.setAttribute("aria-hidden", "true");
    paragraph.append(line);
  }
  entry.append(label, paragraph);
  list.append(entry);
  $("story-scroll").scrollTop = $("story-scroll").scrollHeight;
}

function clearPendingStory() {
  $("pending-story")?.remove();
}

async function api(url, options = {}) {
  try {
    if (!activePlayer) throw new Error("Choose a player profile before opening an adventure.");
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}), "X-Player-Name": activePlayer }
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(response.ok
        ? "The server returned an unreadable response. Please try again."
        : `The server could not complete the request (HTTP ${response.status}). Please try again.`);
    }
    if (!response.ok) {
      const requestReference = typeof body?.requestId === "string" ? ` (Reference: ${body.requestId})` : "";
      throw new Error(`${body?.error || `The server returned HTTP ${response.status}.`}${requestReference}`);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("The server returned an unexpected response. Please try again.");
    }
    return body;
  } catch (error) {
    const reportedError = error instanceof Error ? error : new Error("Unable to contact the game server. Please try again.");
    if (error instanceof TypeError) reportedError.message = "Unable to contact the game server. Check your connection and try again.";
    toastService.showError(reportedError);
    throw reportedError;
  }
}

async function choosePlayer(name) {
  if (!VALID_PLAYERS.includes(name)) return;
  activePlayer = name;
  try {
    sessionStorage.setItem("story-sprout-player", name);
    $("active-player").textContent = name;
    $("profile-error").textContent = "";
    activeWorld = null;
    worlds = [];
    renderWorldList();
    await refreshWorlds();
    showView("welcome");
  } catch (error) {
    activePlayer = null;
    sessionStorage.removeItem("story-sprout-player");
    $("profile-error").textContent = error.message;
    toastService.showError(error);
  }
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
  Object.keys(config).forEach(key => config[key] = key === "name" || key === "description" ? "" : null);
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
  } else if (step.key === "description") {
    const textarea = document.createElement("textarea");
    textarea.id = "world-description";
    textarea.className = "name-input world-description";
    textarea.maxLength = 1000;
    textarea.rows = 5;
    textarea.placeholder = "For example: My fox ranger protects a hidden forest village and is searching for the friend who taught them archery.";
    textarea.value = config.description;
    textarea.setAttribute("aria-label", "Optional description of your world and your character's role");
    textarea.addEventListener("input", () => {
      config.description = textarea.value;
      $("description-count").textContent = `${textarea.value.length} / 1,000`;
    });
    const footer = document.createElement("div");
    footer.className = "description-footer";
    const optionalLabel = document.createElement("span");
    optionalLabel.textContent = "OPTIONAL";
    const count = document.createElement("span");
    count.id = "description-count";
    count.textContent = `${textarea.value.length} / 1,000`;
    footer.append(optionalLabel, count);
    card.append(textarea, footer);
    setTimeout(() => textarea.focus(), 0);
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
        if (step.key === "setting") {
          config.race = null;
          config.archetype = null;
        }
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
  if (!step.optional && step.key !== "name" && !config[step.key]) {
    $("setup-error").textContent = "Choose an answer to continue.";
    return;
  }
  if (stepIndex < steps.length - 1) {
    stepIndex++;
    renderStep();
    return;
  }
  $("setup-pending").classList.remove("hidden");
  $("setup-pending-text").textContent = "Preparing the opening scene...";
  setBusy(true, "Creating your world...");
  try {
    const { world } = await api("/api/worlds", { method: "POST", body: JSON.stringify({ config }) });
    activeWorld = world;
    await refreshWorlds();
    renderGame();
    showView("game");
  } catch (error) {
    $("setup-error").textContent = error.message;
    toastService.showError(error);
  } finally {
    $("setup-pending").classList.add("hidden");
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
    toastService.showError(error);
  }
}

function renderGame() {
  if (!activeWorld) return;
  const { config: hero, state } = activeWorld;
  const heroRace = hero.race || hero.species || (hero.characterKind === "Human" ? "Human" : "Unknown race");
  $("game-title").textContent = `${hero.name}'s adventure`;
  $("world-setting").textContent = hero.setting;
  $("character-line").textContent = `${hero.gender} ${heroRace} · ${hero.archetype}`;
  $("opening-text").textContent = activeWorld.opening;
  $("panel-name").textContent = hero.name;
  $("panel-subtitle").textContent = `${heroRace} · ${hero.archetype}`;
  $("hero-badge").textContent = heroRace === "Human" ? "✦" : heroRace === "Fox" ? "♧" : "✿";
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
  showPendingStory(action ? "The narrator is shaping your turn..." : "The story is continuing...");
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
    clearPendingStory();
    toastService.showError(error);
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
    toastService.showError(error);
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
    toastService.showError(error);
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
$("toast-dismiss").addEventListener("click", () => toastService.dismiss());
document.querySelectorAll(".profile-option").forEach(button => {
  button.addEventListener("click", () => choosePlayer(button.dataset.player));
});
$("switch-player").addEventListener("click", () => {
  try {
    activePlayer = null;
    sessionStorage.removeItem("story-sprout-player");
    $("active-player").textContent = "Choose player";
    activeWorld = null;
    worlds = [];
    renderWorldList();
    showView("player");
  } catch (error) {
    toastService.showError(error);
  }
});

window.addEventListener("error", event => {
  toastService.showError(event.error || new Error(event.message || "An unexpected error occurred."));
});
window.addEventListener("unhandledrejection", event => {
  toastService.showError(event.reason || new Error("An unexpected error occurred."));
});

try {
  const savedPlayer = sessionStorage.getItem("story-sprout-player");
  if (VALID_PLAYERS.includes(savedPlayer)) {
    choosePlayer(savedPlayer);
  } else {
    showView("player");
  }
} catch (error) {
  showView("player");
  toastService.showError(error);
}
