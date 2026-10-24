# Story Sprout

Story Sprout is a kid-friendly, AI-assisted text adventure with multiple saved worlds, customizable heroes, persistent story turns, and a definite player inventory.

## Run with Docker Compose

```sh
docker compose up --build -d
```

Open [http://localhost:3002](http://localhost:3002). Only the UI is published to the host; it proxies `/api/` requests to the backend over the internal Docker network, so the browser uses the same port for both. The backend listens on container port 3003, which is not published on the host. SQLite data is kept in the `story-sprout-data` Docker volume. Set `UI_PORT` to change the host port if 3002 is already in use.

Configure the OpenAI-compatible local chat-completions service with environment variables before starting Compose:

```sh
AI_BASE_URL=http://192.168.0.48:33821/v1 \
AI_MODEL=your-model-name \
docker compose up --build -d
```

`AI_BASE_URL` is the base URL (the app appends `/chat/completions`). For a service running on the Docker host, use a host-reachable address; `localhost` inside the container refers to the container itself. Set `AI_API_KEY` only if your local service requires one, and optionally adjust `AI_TIMEOUT_MS`.

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
