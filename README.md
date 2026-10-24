# Story Sprout

Story Sprout is a kid-friendly, AI-assisted text adventure with multiple saved worlds, customizable heroes, persistent story turns, and a definite player inventory.

## Run with Docker Compose

```sh
docker compose up --build -d
```

Open [http://localhost:3002](http://localhost:3002). Only the UI is published to the host; it proxies `/api/` requests to the backend over the internal Docker network, so the browser uses the same port for both. The backend listens on container port 3003, which is not published on the host. SQLite data is kept in the `story-sprout-data` Docker volume. Set `UI_PORT` to change the host port if 3002 is already in use.

At startup, choose Nate, Hannah, Hudson, or William. Each profile sees and manages only its own worlds, including story turns and state. The app remembers the selection for the current browser tab; use the profile switcher when another player takes over. During world setup, players can optionally add a short description of their world and their character's role; this detail is saved with the world and included in story generation. Existing worlds created before profiles were added are assigned to Nate during the one-time database migration. These profiles separate family members' worlds but are not password-protected accounts.

Backend request failures return a consistent JSON error with a request reference, and the UI displays backend, network, and unexpected client errors in a dismissible toast at the bottom of the screen. Detailed backend exceptions are logged server-side; unexpected errors return a generic user-facing message.

Story creation asks players to choose a setting-specific race: fantasy ancestries, science-fiction species, Human in modern-day stories, or animal-folk in the Mythical animal kingdom. The backend validates race choices against the selected setting. Older saved worlds retain their original character details. For each player turn, the backend calls the local model to summarize the opening scene and all prior action-response pairs, generate the next story response using that summary and the latest five previous action-response pairs, and then extract proposed player-state changes from the response. Each AI call is logged separately. State changes are only applied when evidence is an exact substring of the generated story, numeric changes state their amounts, inventory additions describe an explicit acquisition, and removals refer to an item already owned. This keeps the model's suggestions subordinate to deterministic backend validation. Story generation displays an inline skeleton message in the story history instead of blocking the screen. The narrator aims for thoughtful, grounded middle-grade adventure with meaningful dilemmas and consequences, avoiding toddler-oriented phrasing while keeping content age-appropriate. Anthropomorphic animal heroes and societies are limited to the Mythical animal kingdom setting; animals in other settings remain ordinary wildlife.

Configure the OpenAI-compatible local chat-completions service with environment variables before starting Compose:

```sh
AI_BASE_URL=http://192.168.0.48:33821/v1 \
AI_MODEL=your-model-name \
docker compose up --build -d
```

`AI_BASE_URL` is the base URL (the app appends `/chat/completions`). For a service running on the Docker host, use a host-reachable address; `localhost` inside the container refers to the container itself. Set `AI_API_KEY` only if your local service requires one. Each AI request has a five-minute timeout by default (`AI_TIMEOUT_MS=300000`). Since a player turn makes three sequential AI requests, the UI proxy allows up to 15 minutes plus a small margin for a turn to complete.

## Run locally

Requires Node.js 22.5 or newer.

```sh
npm start
```

The app listens on port 3003 by default and serves the UI and API from that port when run directly. Set `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `PORT`, or `DATABASE_PATH` to customize it.

## Safety and player state

The backend rejects a small set of clearly unsuitable input terms, instructs the model to keep stories age-appropriate, and blocks generated text containing those terms. Story turns and safe AI responses are logged in SQLite. Health, level, gold, inventory, and relationship state are saved per world; inventory removals require an existing item, and additions require the item to be explicitly named in a narrated acquisition. Erasing a turn restores the state snapshot from before it.

These checks are safeguards, not a substitute for adult supervision or a dedicated moderation model. For stronger coverage, use a locally hosted model with a moderation endpoint or add a second local safety classifier.

Run the unit tests with `npm test`.
