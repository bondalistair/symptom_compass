require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. Requests to /api/analyze will fail until you add it to .env');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Rate limiting ---------------------------------------------------------
// Simple in-memory limiter: max 8 requests per IP per 10 minutes.
// Swap for a real store (Redis) before scaling past a single server instance.
const rateLimitWindowMs = 10 * 60 * 1000;
const rateLimitMax = 8;
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const record = hits.get(ip) || { count: 0, start: now };

  if (now - record.start > rateLimitWindowMs) {
    record.count = 0;
    record.start = now;
  }
  record.count += 1;
  hits.set(ip, record);

  if (record.count > rateLimitMax) {
    return res.status(429).json({ error: "You've tried a few times recently — take a short break and try again shortly." });
  }
  next();
}

// --- Shareable result storage ----------------------------------------------
// A JSON-file-backed store so a generated result can be reopened via a link,
// even after the browser tab is closed. Links expire after 30 days.
// Prototype-grade: fine to start with, move to a real database before
// meaningful traffic (a single JSON file doesn't handle concurrent writes
// well or scale across multiple server instances).
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'results.json');
const RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const now = Date.now();
  const pruned = {};
  for (const [id, entry] of Object.entries(store)) {
    if (now - entry.createdAt < RESULT_TTL_MS) pruned[id] = entry;
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(pruned));
}

function saveResult(data) {
  const store = loadStore();
  const id = crypto.randomBytes(9).toString('base64url');
  store[id] = { data, createdAt: Date.now() };
  saveStore(store);
  return id;
}

function getResult(id) {
  const store = loadStore();
  const entry = store[id];
  if (!entry) return null;
  if (Date.now() - entry.createdAt >= RESULT_TTL_MS) return null;
  return entry.data;
}

// --- Contact / assessment request storage -----------------------------------
// Stores "Get a Free Assessment" form submissions until you have a real
// booking system or CRM. Contains personal data (name, email, phone) —
// treat data/contact-requests.json as sensitive, never commit it to git,
// and view it only through the password-protected endpoint below.
const CONTACT_STORE_PATH = path.join(DATA_DIR, 'contact-requests.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function loadContactRequests() {
  try {
    return JSON.parse(fs.readFileSync(CONTACT_STORE_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveContactRequest(entry) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const requests = loadContactRequests();
  requests.unshift(entry);
  fs.writeFileSync(CONTACT_STORE_PATH, JSON.stringify(requests));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// --- Crisis detection backstop ----------------------------------------------
// Runs before the model call, as a fast, local second check.
const CRISIS_KEYWORDS = [
  'kill myself', 'suicide', 'suicidal', 'end my life', 'want to die',
  'hurting myself', 'hurt myself', 'self harm', 'self-harm', 'no reason to live'
];

function localCrisisCheck(text) {
  const lower = text.toLowerCase();
  return CRISIS_KEYWORDS.some(k => lower.includes(k));
}

const SYSTEM_PROMPT = `You are a cautious triage-support assistant embedded in a wellbeing web app. A user has described symptoms they've been experiencing. Your job:

1. FIRST assess whether the text suggests acute risk: suicidal ideation, intent to self-harm, intent to harm others, or a mental health emergency. If yes, set "crisis_flag": true.
2. If not in crisis, suggest 2-4 evidence-based therapy modalities commonly used for symptoms like this (e.g. CBT, ACT, DBT, psychodynamic therapy, EMDR, IPT, exposure therapy, family/systemic therapy, somatic therapies). For each, give a one-to-two sentence plain-language rationale and a confidence level (high/moderate/low) reflecting how well-established that modality is for this presentation.
3. NEVER diagnose a condition. Describe symptom patterns, not disorders, where possible.
4. Always include a short clinician_note reminding the user this is a starting point for a conversation with a licensed professional, not a treatment plan.
5. Respond with ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:

{
  "crisis_flag": boolean,
  "directions": [
    { "therapy": string, "rationale": string, "confidence": "high" | "moderate" | "low" }
  ],
  "intro": string,
  "clinician_note": string
}

If crisis_flag is true, "directions" can be an empty array and "intro" should briefly and gently acknowledge what they shared without minimizing it.`;

function crisisFallback() {
  return {
    crisis_flag: true,
    directions: [],
    intro: "What you've shared suggests you might be going through something urgent.",
    clinician_note: 'Please use the crisis resources shown below and reach out to a real person now.'
  };
}

app.post('/api/analyze', rateLimit, async (req, res) => {
  try {
    const { symptoms, duration, intensity } = req.body || {};

    if (!symptoms || typeof symptoms !== 'string' || !symptoms.trim()) {
      return res.status(400).json({ error: 'Please describe what you have been experiencing.' });
    }
    if (symptoms.length > 4000) {
      return res.status(400).json({ error: 'That description is too long. Please shorten it.' });
    }

    if (localCrisisCheck(symptoms)) {
      const fallback = crisisFallback();
      const resultId = saveResult(fallback);
      return res.json({ ...fallback, resultId });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: 'Server is not configured with an API key yet.' });
    }

    let userMessage = `Symptoms described: ${symptoms}`;
    if (duration) userMessage += `\nApproximate duration: ${duration}`;
    if (intensity) userMessage += `\nImpact on daily life: ${intensity}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'The model call failed. Please try again.' });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No response received from the model.' });
    }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse model JSON:', cleaned);
      return res.status(502).json({ error: 'Received an unexpected response format. Please try again.' });
    }

    if (localCrisisCheck(symptoms)) {
      parsed.crisis_flag = true;
    }

    const resultId = saveResult(parsed);
    res.json({ ...parsed, resultId });

  } catch (err) {
    console.error('Unexpected error in /api/analyze:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again in a moment.' });
  }
});

app.get('/api/results/:id', (req, res) => {
  const data = getResult(req.params.id);
  if (!data) {
    return res.status(404).json({ error: 'This link has expired or is no longer valid.' });
  }
  res.json(data);
});

app.post('/api/contact-request', rateLimit, (req, res) => {
  const { name, email, phone, therapy, message } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (name.length > 200 || (phone && phone.length > 50) || (message && message.length > 2000)) {
    return res.status(400).json({ error: 'One of the fields is too long. Please shorten it.' });
  }

  const entry = {
    id: crypto.randomBytes(9).toString('base64url'),
    name: name.trim(),
    email: email.trim(),
    phone: (phone || '').trim(),
    therapy: (therapy || '').trim(),
    message: (message || '').trim(),
    createdAt: Date.now()
  };

  saveContactRequest(entry);
  res.json({ ok: true });
});

app.get('/api/contact-requests', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not set on the server yet. Add it to your .env file to view requests.' });
  }
  if (req.query.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  res.json(loadContactRequests());
});

app.listen(PORT, () => {
  console.log(`Symptom Compass server running on http://localhost:${PORT}`);
});
