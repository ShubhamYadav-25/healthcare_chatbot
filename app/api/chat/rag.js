// rag.js
// Symptom → Disease probability engine + vector embedding similarity
// Exports:
//   retrieveCondition(query, options) -> { diseases: [...topN], symptoms, queryEmbedding }
//   pickMostInformativeSymptom(topDiseases, askedSet)
//   isEmergency(text)
//   extractFromMessage(text, lastDiagnosis?) -> { intent, yes_no, symptoms, slots, is_emergency, resolvedCondition, wellnessTopic }
//   generateContextualAdvice(condition, userQuestion) -> string
//   generateWellnessAdvice(topic, userQuestion) -> string

import clientPromise from "../../mongodb";

/* ------------- Config -------------- */
// FIX: router.huggingface.co requires the /hf-inference/ prefix for the hosted inference provider
const EMBEDDING_ENDPOINT =
  "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction";

const TOP_K = 6;

/* ------------- Shared Groq caller -------------- */
async function _callGroq(prompt, temperature, max_tokens) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature,
        max_tokens
      })
    });
    if (!res.ok) {
      console.warn("Groq API error:", await res.text());
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn("Groq call failed:", err);
    return null;
  }
}

/* ------------- LLM Extraction via Groq -------------- */
/**
 * extractFromMessage(text, lastDiagnosis?)
 *
 * Classifies user intent. The general_wellness intent (new) is the key fix for
 * Quick Action prompts like "Can you share mental wellness tips?" and
 * "How can I improve my sleep?" being misrouted to RAG which returned irrelevant
 * disease matches at 28-30%.
 *
 * Intent list:
 *   symptom_intake     - user describes personal symptoms they are experiencing
 *   info_query         - asks what a specific named disease is
 *   condition_followup - follow-up on a previously diagnosed condition
 *   general_wellness   - general health/wellness tips NOT tied to a specific symptom
 *   greeting           - simple greeting
 *   yes_no_answer      - yes/no response to a triage question
 *   unknown            - none of the above
 */
export async function extractFromMessage(text, lastDiagnosis = null) {
  if (!text) {
    return {
      intent: "unknown",
      yes_no: "UNKNOWN",
      symptoms: [],
      slots: {},
      is_emergency: false,
      resolvedCondition: null,
      wellnessTopic: null
    };
  }

  const contextLine = lastDiagnosis
    ? "Context: The patient was just triaged and the most likely condition identified was \"" +
      lastDiagnosis.condition +
      "\". Pronouns like \"it\", \"this\", \"recover from it\" refer to this condition.\n"
    : "";

  const prompt =
    "You are a medical triage assistant. Analyze the patient message and return ONLY valid JSON.\n" +
    contextLine +
    "Patient message: \"" + text.replace(/"/g, "'") + "\"\n\n" +
    "Return exactly this JSON shape with no extra text:\n" +
    "{\n" +
    "  \"intent\": \"<symptom_intake|info_query|condition_followup|general_wellness|greeting|yes_no_answer|unknown>\",\n" +
    "  \"yes_no\": \"<YES|NO|UNKNOWN>\",\n" +
    "  \"symptoms\": [],\n" +
    "  \"slots\": { \"age\": null, \"sex\": null, \"duration\": null, \"onset\": null, \"severity\": null },\n" +
    "  \"is_emergency\": false,\n" +
    "  \"resolvedCondition\": null,\n" +
    "  \"wellnessTopic\": null\n" +
    "}\n\n" +
    "Intent rules — pick the SINGLE best match:\n" +
    "- symptom_intake: user describes symptoms they personally have right now (\"I have fever\", \"my head hurts\")\n" +
    "- info_query: asks what a specific named disease is (\"what is diabetes?\", \"tell me about asthma\")\n" +
    "- condition_followup: asks about a previously diagnosed condition — diet, recovery, treatment, prevention\n" +
    "- general_wellness: asks for general health/wellness tips NOT about a specific current symptom or named disease. USE THIS for: mental health tips, stress/anxiety advice, sleep improvement, nutrition tips, exercise advice, medication interaction info, emergency warning signs education, vague intents like \"help me understand my health\". Examples that MUST use this intent: \"I've been feeling stressed and anxious, can you share mental wellness tips?\", \"How can I improve my sleep quality?\", \"What are signs of a medical emergency?\", \"Can you explain medication interactions?\", \"Give me nutrition tips\", \"I'd like help understanding some symptoms I'm experiencing\" (vague, no specific symptoms stated)\n" +
    "- greeting: hi/hello with no health content\n" +
    "- yes_no_answer: direct yes or no in reply to a triage question\n" +
    "- unknown: nothing else fits\n\n" +
    "For wellnessTopic: only set when intent=general_wellness. Use one of: mental wellness, sleep health, nutrition, medication interactions, emergency signs, stress management, exercise, general health";

  const raw = await _callGroq(prompt, 0, 400);
  if (!raw) return _fallbackExtract(text);

  // FIX: LLM sometimes prepends explanation text before the JSON despite instructions
  // (e.g. "Based on the patient message... Here is the valid JSON: {...}")
  // Extract the first {...} block found rather than assuming the whole response is JSON.
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in response");
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn("extractFromMessage parse failed:", err.message, "| raw:", raw.slice(0, 120));
    return _fallbackExtract(text);
  }
}

/**
 * _fallbackExtract: safe fallback when Groq is unavailable.
 */
function _fallbackExtract(text) {
  const lower = (text || "").toLowerCase();

  const emergencyKeywords = [
    "chest pain", "can't breathe", "cant breathe", "not breathing",
    "unconscious", "stroke", "severe bleeding", "heart attack"
  ];
  const is_emergency = emergencyKeywords.some(k => lower.includes(k));

  const greetings = ["hi", "hello", "hey", "good morning", "good evening"];
  const isGreeting = greetings.some(g => lower.startsWith(g) || lower === g);

  // Wellness keywords — broad enough to catch all Quick Action prompts
  const wellnessKeywords = [
    "stress", "anxious", "anxiety", "mental", "wellness", "sleep", "nutrition",
    "diet tip", "healthy", "exercise", "medication interaction", "side effect",
    "emergency sign", "tips", "improve my", "advice", "suggest me", "help me understand"
  ];
  const isWellness = wellnessKeywords.some(k => lower.includes(k));

  const intakeKeywords = ["i have", "i feel", "i am experiencing", "my body", "my chest", "my stomach", "pain", "ache", "fever", "cough", "rash"];
  const isIntake = intakeKeywords.some(t => lower.includes(t));

  let intent = "unknown";
  if (isGreeting) intent = "greeting";
  else if (isWellness && !isIntake) intent = "general_wellness";
  else if (isIntake) intent = "symptom_intake";

  return {
    intent,
    yes_no: "UNKNOWN",
    symptoms: [],
    slots: {},
    is_emergency,
    resolvedCondition: null,
    wellnessTopic: isWellness ? "general health" : null
  };
}

/* ------------- Contextual Advice (post-triage follow-up) -------------- */
/**
 * generateContextualAdvice(condition, userQuestion)
 * For follow-up questions about a specific already-diagnosed condition.
 */
export async function generateContextualAdvice(condition, userQuestion) {
  if (!condition || !userQuestion) return null;

  const prompt =
    "You are a helpful, cautious medical information assistant. The patient has been informed that their symptoms are most consistent with \"" + condition + "\".\n\n" +
    "They are now asking: \"" + userQuestion.replace(/"/g, "'") + "\"\n\n" +
    "Provide a clear, accurate, and practical response specifically about " + condition + ". " +
    "Keep your answer focused and concise (3-5 short paragraphs). Do not diagnose or prescribe. " +
    "End with a reminder to consult a healthcare professional.\n" +
    "Do NOT mention confidence percentages, triage scores, or internal system details.";

  return _callGroq(prompt, 0.3, 600);
}

/* ------------- General Wellness Advice (NEW) -------------- */
/**
 * generateWellnessAdvice(topic, userQuestion)
 *
 * Called for general health/wellness questions that are NOT symptom-based.
 * This is the correct handler for all Quick Action prompts:
 *   "Can you share some mental wellness tips?"       -> topic: mental wellness
 *   "How can I improve my sleep quality?"            -> topic: sleep health
 *   "Give me evidence-based nutrition tips"          -> topic: nutrition
 *   "What are signs of a medical emergency?"         -> topic: emergency signs
 *   "Explain common medication interactions"         -> topic: medication interactions
 *   "I'd like help understanding some symptoms..."   -> topic: general health
 *
 * Previously these all fell through to RAG retrieval which returned random disease
 * matches (Asthma 28%, Influenza 28%, Hypertension 28%) because the conditions DB
 * only contains symptom→disease mappings, not wellness knowledge.
 */
export async function generateWellnessAdvice(topic, userQuestion) {
  if (!userQuestion) return null;

  const topicHint = topic ? " The topic area is: " + topic + "." : "";

  const prompt =
    "You are a knowledgeable, warm, and responsible health and wellness advisor." + topicHint + "\n\n" +
    "The user is asking: \"" + userQuestion.replace(/"/g, "'") + "\"\n\n" +
    "Provide practical, evidence-based, and easy-to-understand guidance. " +
    "Structure your response with a short intro, then 4-6 clear actionable tips (use short paragraphs, not a numbered list unless it naturally fits), and a brief closing. " +
    "Use plain conversational language. Do not diagnose conditions or prescribe medications. " +
    "If the question hints at a possible underlying medical issue, gently suggest consulting a healthcare professional.";

  return _callGroq(prompt, 0.4, 700);
}

/* ------------- Embedding API (HuggingFace free tier) -------------- */
export async function getEmbedding(text) {
  if (!text) return null;
  try {
    const res = await fetch(EMBEDDING_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.HF_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: text })
    });

    if (!res.ok) {
      console.warn("HuggingFace embedding API error:", await res.text());
      return null;
    }

    const data = await res.json();
    if (Array.isArray(data) && Array.isArray(data[0])) return data[0];
    if (Array.isArray(data) && typeof data[0] === "number") return data;
    return null;
  } catch (err) {
    console.warn("Embedding fetch failed:", err);
    return null;
  }
}

/* ------------- Cosine similarity helpers -------------- */
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}
function magnitude(v) {
  return Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
}
function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const denom = magnitude(a) * magnitude(b);
  if (denom === 0) return 0;
  return dot(a, b) / denom;
}

/* ------------- Scoring -------------- */
function computeSymptomProb(disease, extractedSymptoms) {
  if (!extractedSymptoms || extractedSymptoms.length === 0) return 0.05;
  const weights = disease.symptom_weights || {};
  let matched = 0;
  let total = 0;
  for (const [s, w] of Object.entries(weights)) {
    total += w;
    if (extractedSymptoms.some(es => es.toLowerCase().includes(s) || s.includes(es.toLowerCase()))) {
      matched += w;
    }
  }
  if (total === 0) return 0.01;
  return Math.min(1, Math.max(0, matched / total));
}

function combineScores(symptomProb, semanticSim, alpha = 0.55) {
  const sem = (semanticSim + 1) / 2;
  const sProb = Math.min(1, Math.max(0, symptomProb));
  return alpha * sem + (1 - alpha) * sProb;
}

/* ------------- Main Retrieval -------------- */
export async function retrieveCondition(query, options = {}) {
  const client = await clientPromise;
  const db = client.db("healthcare");
  const collection = db.collection("conditions");

  const extracted = options.symptoms && options.symptoms.length > 0 ? options.symptoms : [];

  let augmentedQuery = query || "";
  if (options.slots) {
    const s = options.slots;
    if (s.age) augmentedQuery += " patient age " + s.age;
    if (s.sex) augmentedQuery += " " + s.sex + " patient";
    if (s.duration) augmentedQuery += " duration " + s.duration;
    if (s.onset) augmentedQuery += " " + s.onset + " onset";
    if (s.severity) augmentedQuery += " " + s.severity + " severity";
  }

  const queryEmbedding = await getEmbedding(augmentedQuery);
  const docs = await collection.find({}).toArray();
  const scored = [];

  for (const doc of docs) {
    const symptomProb = computeSymptomProb(doc, extracted);
    let semanticSim = 0;

    if (queryEmbedding && Array.isArray(doc.embedding) && doc.embedding.length) {
      semanticSim = cosineSimilarity(queryEmbedding, doc.embedding);
    } else {
      const keySet = new Set([
        ...(doc.keywords || []),
        ...Object.keys(doc.symptom_weights || {})
      ]);
      const q = augmentedQuery.toLowerCase();
      let hits = 0;
      for (const k of keySet) {
        if (k && q.includes(k.toLowerCase())) hits++;
      }
      semanticSim = (hits / (keySet.size || 1)) * 0.6;
    }

    const score = combineScores(symptomProb, semanticSim);
    scored.push({ disease: doc, symptomProb, semanticSim, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return { diseases: scored.slice(0, options.topK || TOP_K), symptoms: extracted, queryEmbedding };
}

/* ------------- Dynamic Question Selection -------------- */
export function pickMostInformativeSymptom(topDiseases, askedSet = new Set()) {
  const symptomValues = {};

  for (const entry of topDiseases) {
    const weights = entry.disease.symptom_weights || {};
    for (const [symptom, w] of Object.entries(weights)) {
      if (askedSet.has(symptom)) continue;
      if (!symptomValues[symptom]) symptomValues[symptom] = [];
      symptomValues[symptom].push(w * (entry.score || 0.001));
    }
  }

  const ranked = Object.entries(symptomValues).map(([symptom, vals]) => {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return { symptom, variance };
  }).sort((a, b) => b.variance - a.variance);

  return ranked[0]?.symptom || null;
}

/* ------------- Emergency Check -------------- */
export function isEmergency(text) {
  const lower = (text || "").toLowerCase();
  const keywords = [
    "chest pain", "can't breathe", "cant breathe", "not breathing",
    "unconscious", "stroke", "severe bleeding", "heart attack",
    "severe shortness of breath", "my chest hurts badly",
    "pressure in my chest", "i think i'm having a heart attack"
  ];
  return keywords.some(k => lower.includes(k));
}
