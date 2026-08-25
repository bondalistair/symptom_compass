# Symptom Compass

A landing page plus an AI-assisted tool that suggests evidence-based therapy
directions from a description of someone's symptoms. Built on the Claude API.
Not a diagnostic tool.

## Project structure

```
symptom-compass/
├── server/
│   └── index.js          Express server — the only place the API key lives
├── public/
│   ├── index.html          Landing page (site homepage)
│   ├── tool.html            The assessment tool itself
│   ├── contact.html         "Get a Free Assessment" request form
│   ├── admin.html           Password-protected view of submitted requests
│   ├── cbt-info.html, act-info.html, ... (9 files)   Therapy modality explainer pages
├── package.json
├── .env.example              Copy to .env and fill in your details
└── .gitignore
```

## How it works

The browser never talks to Anthropic directly. `tool.html` POSTs to your own
`/api/analyze` endpoint; the server attaches your API key, calls Claude, and
returns the parsed result. The visitor journey is:

**Landing page (`/`)** → click "Start assessment" → **`tool.html`** → describe
symptoms → results, each with a sourced "why" link to the relevant explainer
page and, for high-confidence suggestions, a "Get a Free Assessment" button →
**`contact.html`** → submission saved server-side → you review it at
**`admin.html`**.

Two layers of crisis handling in `tool.html`:
1. A local keyword check runs first, before any API call, as a fast backstop.
2. The model itself is instructed to assess risk and set `crisis_flag`.
Either one triggers the crisis banner instead of therapy suggestions. Two
"Crisis support" buttons are also always visible on the page — no typing or
waiting required to reach help.

There's also a simple in-memory rate limiter (8 requests per IP per 10
minutes) on both `/api/analyze` and `/api/contact-request`.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18 or later.

```bash
cd symptom-compass
npm install
cp .env.example .env
# edit .env: paste in your Anthropic API key and pick an admin password
npm start
```

Then open **http://localhost:3000**.

Get an API key at https://console.anthropic.com if you don't have one.

## Assessment request form

Each "Get a Free Assessment" button leads to `contact.html`, where someone
can leave their name, email, phone (optional), and a note. Submissions are
saved to `data/contact-requests.json` on the server.

To view submissions, go to **yoursite.com/admin.html** and enter the
password you set as `ADMIN_PASSWORD`. Without that password set, the admin
page won't return any data — it fails safe rather than exposing requests to
anyone who finds the URL.

This is a simple mailbox, not a CRM — no status tracking or automatic
follow-up. Check `/admin.html` regularly, and treat
`data/contact-requests.json` as sensitive (real names, emails, phone
numbers tied to a mental-health context) — it's already excluded from git.

## Shareable result links

After getting results, someone can click "Copy shareable link" to get a URL
like `yoursite.com/tool.html?id=xyz123` that reopens the same result later,
even after closing the tab. Stored in `data/results.json`, expires after 30
days automatically. The link itself is the only thing protecting a result —
there's no login system, so treat it like an unlisted document link.

## Deploying it

Standard Node/Express app — Render or Railway both work well and have free
tiers: connect your GitHub repo, set `ANTHROPIC_API_KEY` and
`ADMIN_PASSWORD` as environment variables in the dashboard, and it deploys
automatically. Never put either value directly in code or commit `.env`.

## Before you take this further

- **Legal/regulatory check** — a tool suggesting therapy directions from
  symptoms may brush up against medical device rules (FDA SaMD, EU MDR) in
  some jurisdictions, even while explicitly non-diagnostic.
- **Real rate limiting** if this goes on the open internet — the in-memory
  limiter here is a starting point, not a finished solution.
- **A real database** before meaningful traffic — the JSON-file stores for
  results and contact requests are prototype-grade.
- **A retention/deletion policy** for contact requests and shared results,
  depending on your data protection obligations.
