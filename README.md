MediAssist — Healthcare Chatbot

MediAssist is a small Next.js demo implementing a lightweight RAG (Retrieval-Augmented Generation) triage flow with a streaming chat UI. It demonstrates how to combine deterministic retrieval logic with a streaming LLM fallback (Groq API) for open-ended replies.

---

## Core concepts

- **RAG (Retrieve & Augment):** The server attempts to match the user's initial message to a known condition using a retrieval helper. If a match is found, the app runs a deterministic follow-up (triage) flow based on the retrieved document's follow-up questions.
- **Deterministic triage:** When a condition is detected, the server asks a series of deterministic yes/no follow-ups (from the retrieved doc) and computes a final structured summary + confidence score.
- **Emergency override:** Messages detected as emergencies trigger an immediate emergency response and bypass LLM or RAG logic.
- **LLM fallback (streaming):** If no RAG match is found or after triage, the server falls back to a streaming LLM completion using the Groq API. The fallback streams partial text to the client using a Server-Sent-Events (SSE)-style stream.
- **Client streaming UI:** The React client (`app/page.jsx`) reads the stream in small chunks, appends tokens to the assistant message progressively, and shows typing dots while waiting.

---

## Important files

- Server triage & fallback: [app/api/chat/route.js](app/api/chat/route.js)
- Retrieval helper: [app/api/chat/rag.js](app/api/chat/rag.js)
- Client chat UI: [app/page.jsx](app/page.jsx)

---

## How the server flow works (high level)

1. Client POSTs to `/api/chat` with the full message history. The server inspects the latest user message.
2. Emergency detection: if the message appears to be an emergency (e.g., mentions "911" or "emergency room"), the server immediately returns a short emergency alert stream and stops further processing.
3. Reset handling: messages containing reset triggers (e.g., "reset", "start over") cause the server to reset the in-memory triage session and prompt the user to describe symptoms.
4. RAG retrieval: when the session has no active document, the server calls `retrieveCondition()` from [app/api/chat/rag.js](app/api/chat/rag.js). If a document match with sufficient confidence is returned, the server enters `triage` mode and begins asking follow-up questions from the matched document.
5. Deterministic triage: in `triage` mode the server treats affirmative replies as confirmations of follow-up symptoms, increments a question index, and asks the next follow-up until all follow-ups are exhausted.
6. Structured summary: when follow-ups complete, the server composes a structured summary including a confidence score (blend of RAG similarity and symptom match percentage), returns it, and resets the session state to idle.
7. LLM fallback (general): if no RAG match is made, the server forwards the chat to the Groq streaming endpoint. The response is streamed back to the client and forwarded through the route as SSE-like `data: ...` chunks.

---

## Streaming format

- The server returns a `text/event-stream`-style response. Each chunk is wrapped like `data: {"text":"partial text"}\n\n`. The client (browser) reads the stream, parses `data: ...` lines, and appends `text` to the assistant message until `data: [DONE]` is received.

---

## Runtime & configuration

- The Groq fallback uses the `GROQ_API_KEY` environment variable. Set it in your environment before running the app:

```bash
# Windows (PowerShell)
$env:GROQ_API_KEY = "your-key-here"

# macOS / Linux
export GROQ_API_KEY="your-key-here"
```

- The route sets a `MODEL` constant (for the Groq call) — leave this as-is or change to a compatible model string in the server code: see [app/api/chat/route.js](app/api/chat/route.js).

---

## Client behavior (UI)

- The chat UI at [app/page.jsx](app/page.jsx) handles input, shows a welcome screen with quick actions, and streams assistant output in real time.
- It shows a special styled emergency alert if the assistant content or the user's message appears to be an emergency.
- A floating reset button posts a simple `reset` message to the API route to clear in-memory triage state.

---

## Development

Install and run the app as usual for Next.js:

```bash
npm install
npm run dev
```

Open http://localhost:3000 and try the chat UI. Try these patterns to exercise different flows:

- Ask a simple question (triggers Groq fallback): "What are common causes of headaches?"
- Describe symptoms to trigger RAG triage (depends on your `rag.js` documents): "I've had a fever and sore throat."
- Trigger emergency: "I think I need to go to the emergency room" or mention "911".
- Reset the conversation by clicking the reset button or sending "reset".

---

## Security & privacy notes

- This demo uses an in-memory `triageState` (global object). Replace with a database or Redis for production and per-user sessions.
- Do not log or persist PHI (protected health information) in production.
- Validate and sanitize user input if you extend the project.

---

## Next steps / improvements

- Add persistent per-user sessions and authentication.
- Replace in-memory retrieval with a vector DB for more robust RAG retrieval.
- Harden emergency detection and add local emergency resources per region.
- Add unit tests for the triage logic and retrieval helper.

---

If you want, I can also add a short architecture diagram or expand the `rag.js` documentation.
