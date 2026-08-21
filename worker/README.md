# Question Deck AI Worker

Cloudflare Worker that proxies Anthropic API calls for `v2.html`. Holds the API key server-side so it never ships to the browser.

## Routes

| Route | Purpose |
|---|---|
| `POST /seed` | Rough idea → 3 distinct open-ended question variants |
| `POST /batch` | Generate 8 persona-tuned questions (backs "Write new ones") |

Both expect `{ "prompt": "..." }` JSON body and return structured JSON.

## First-time setup

### 1. Install dependencies
```bash
cd worker
npm install
```

### 2. Create the KV namespace for rate limiting
```bash
npx wrangler kv namespace create RATE_LIMIT
```
Copy the `id` from the output and paste it into `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "paste-id-here"
```

### 3. Set your Anthropic API key as a secret (never in wrangler.toml)
```bash
npx wrangler secret put ANTHROPIC_API_KEY
# paste your key when prompted
```

### 4. Configure allowed origins in wrangler.toml
```toml
[vars]
ALLOWED_ORIGINS = "https://sdiasuez11.github.io"
DAILY_CAP = "50"
```

Multiple origins: `"https://sdiasuez11.github.io,http://localhost:8080"`

### 5. Deploy
```bash
npx wrangler deploy
```

The output will show your Worker URL, e.g. `https://question-deck-ai.yourname.workers.dev`.

### 6. Wire v2.html to the Worker
Open `v2.html` and set `WORKER_URL` near line 521:
```js
const WORKER_URL = "https://question-deck-ai.yourname.workers.dev";
```

Then commit and push. Both phones immediately get AI features.

## Local dev

```bash
npx wrangler dev
```

This starts the Worker at `http://localhost:8787`. To test from v2.html locally, temporarily add `http://localhost:5500` (or whatever your local server port is) to `ALLOWED_ORIGINS` in wrangler.toml and set `WORKER_URL` to `http://localhost:8787` in v2.html.

## Tuning

- **`DAILY_CAP`** — total calls per UTC day across both routes combined. 50 is generous; one `/seed` call per session + occasional batches won't come close. Raise it if the deck feels throttled.
- **`ALLOWED_ORIGINS`** — add your local dev origin when testing; remove it before deploying to production.

## Cost estimate

Each call uses claude-opus-5 at ~$5/$25 per MTok input/output. A seed call is ~400 input + ~200 output tokens ≈ $0.007. A batch call is ~600 input + ~500 output ≈ $0.015. At 50 calls/day you're spending less than $0.75/day maximum.
