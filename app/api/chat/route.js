// route.js
// Stateful triage + dynamic question generator + slot filling + greeting/intent handling
// Exports: POST(request)
// Uses streaming responses (SSE-style) compatible with your frontend.

import {
  retrieveCondition,
  pickMostInformativeSymptom,
  isEmergency,
  extractFromMessage,
  generateContextualAdvice,
  generateWellnessAdvice
} from "./rag";
import clientPromise from "../../mongodb";

const STOP_CONFIDENCE = 0.70;
const MAX_QUESTIONS = 6;

/* ---------- Streaming helper ---------- */
function streamText(text) {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: " + JSON.stringify({ text }) + "\n\n"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    }
  });
}

/* ---------- Medical disclaimer ---------- */
const TRIAGE_DISCLAIMER =
  "\n\n⚕️ This is general health information only — not a medical diagnosis. Please consult a qualified healthcare professional for evaluation and treatment.";

/* ---------- MongoDB session helpers ---------- */
/**
 * Setup (run once in Atlas or mongosh):
 *   db.collection("sessions").createIndex({ updatedAt: 1 }, { expireAfterSeconds: 7200 })
 */
async function getSession(sessionId) {
  try {
    const client = await clientPromise;
    const doc = await client.db("healthcare").collection("sessions").findOne({ sessionId });
    if (!doc) return null;
    return {
      ...doc,
      askedSymptoms: new Set(doc.askedSymptoms || []),
      confirmedSymptoms: new Set(doc.confirmedSymptoms || [])
    };
  } catch (err) {
    console.error("getSession error:", err);
    return null;
  }
}

async function saveSession(sessionId, state) {
  try {
    const client = await clientPromise;
    await client.db("healthcare").collection("sessions").updateOne(
      { sessionId },
      {
        $set: {
          ...state,
          askedSymptoms: Array.from(state.askedSymptoms || []),
          confirmedSymptoms: Array.from(state.confirmedSymptoms || []),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("saveSession error:", err);
  }
}

/**
 * freshState()
 * lastDiagnosis intentionally persists across triage reset so follow-up questions
 * like "what diet should I follow for it?" resolve correctly in the next turn.
 */
function freshState() {
  return {
    mode: "idle",
    slots: {},
    symptomsText: null,
    diseases: [],
    askedSymptoms: new Set(),
    confirmedSymptoms: new Set(),
    lastAskedSymptom: null,
    questionsAsked: 0,
    lastDiagnosis: null
  };
}

/* ---------- Question formatting ---------- */
function questionTextForSymptom(symptom) {
  if (!symptom) return null;
  const map = {
    "frequent urination": "Are you urinating more frequently than usual?",
    "excessive thirst": "Have you been feeling unusually thirsty or drinking more than usual?",
    "blurred vision": "Have you noticed any blurred or changed vision recently?",
    "fatigue": "Are you feeling more tired than usual / unusually fatigued?",
    "shortness of breath": "Are you experiencing shortness of breath?",
    "wheezing": "Do you experience wheezing or a whistling sound while breathing?",
    "chest pain": "Do you have chest pain or pressure?",
    "fever": "Have you had a fever recently?",
    "nausea": "Are you experiencing nausea or an upset stomach?",
    "vomiting": "Have you vomited recently?",
    "diarrhea": "Have you had diarrhea?",
    "headache": "Do you have a headache?",
    "rash": "Do you have any skin rash or unusual skin changes?",
    "joint pain": "Are you experiencing joint pain or stiffness?",
    "weight loss": "Have you noticed any unintentional weight loss recently?",
    "increased hunger": "Are you feeling hungrier than usual?",
    "sweating": "Are you sweating more than usual, especially at night?",
    "cough": "Do you have a cough? If so, is it dry or producing mucus?",
    "sore throat": "Do you have a sore throat?",
    "runny nose": "Do you have a runny or stuffy nose?",
    "abdominal pain": "Are you experiencing abdominal or stomach pain?"
  };
  return map[symptom] || "Are you experiencing " + symptom + "?";
}

/* ---------- Probability update (stable Bayesian-lite) ---------- */
function updateProbabilities(diseases, symptom, answer) {
  for (const entry of diseases) {
    const w = Math.max(0.01, Math.min(1, (entry.disease.symptom_weights?.[symptom]) || 0.01));
    if (answer === "YES") {
      entry.score *= 1 + 0.5 * w;
    } else if (answer === "NO") {
      entry.score *= 1 - 0.35 * w;
    } else {
      entry.score *= 0.97;
    }
    entry.score = Math.max(0.0001, entry.score);
  }
  const total = diseases.reduce((s, e) => s + e.score, 0) || 1;
  for (const e of diseases) e.score = e.score / total;
  diseases.sort((a, b) => b.score - a.score);
}

/* ---------- Main handler ---------- */
export async function POST(request) {
  try {
    const body = await request.json();
    const { messages } = body;
    const sessionId = body.sessionId || "default";
    const rawUserMessage = (messages[messages.length - 1]?.content || "").trim();

    // Fast synchronous emergency pre-check
    if (isEmergency(rawUserMessage)) {
      const state = await getSession(sessionId) || freshState();
      await saveSession(sessionId, { ...freshState(), lastDiagnosis: state.lastDiagnosis || null });
      return streamText(
        "⚠️ This sounds like it could be a medical emergency.\n\nPlease call emergency services (911) or go to the nearest emergency department immediately. Do not wait."
      );
    }

    let state = await getSession(sessionId);
    if (!state) state = freshState();

    // LLM extraction — passes lastDiagnosis so pronouns like "it" resolve correctly
    const extracted = await extractFromMessage(rawUserMessage, state.lastDiagnosis || null);

    if (extracted.is_emergency) {
      await saveSession(sessionId, { ...freshState(), lastDiagnosis: state.lastDiagnosis || null });
      return streamText(
        "⚠️ This sounds like it could be a medical emergency.\n\nPlease call emergency services (911) or go to the nearest emergency department immediately. Do not wait."
      );
    }

    const { intent, yes_no, symptoms: llmSymptoms, slots: llmSlots, resolvedCondition, wellnessTopic } = extracted;

    /* ---------- Greeting ---------- */
    if (intent === "greeting") {
      await saveSession(sessionId, state);
      return streamText(
        "Hello! I can help triage your symptoms, give brief condition summaries, and suggest next steps.\n\n" +
        "Tell me your symptoms (e.g., \"I have a cough and fever\") or ask \"What is [condition]?\"."
      );
    }

    /* ---------- General Wellness (NEW) ----------
     *
     * FIX: Handles all Quick Action prompts that are general health/wellness queries:
     *   - "I've been feeling stressed and anxious. Can you share some mental wellness tips?"
     *   - "How can I improve my sleep quality? I've been having trouble sleeping."
     *   - "I'd like help understanding some symptoms I'm experiencing." (vague, no specific symptoms)
     *   - "What are signs of a medical emergency I should know about?"
     *   - "Can you explain common medication interactions and side effects?"
     *   - "Give me evidence-based nutrition tips for a healthier diet."
     *
     * Previously these all fell through to info_query → RAG → random disease matches
     * because the conditions DB only contains symptom→disease data, not wellness knowledge.
     * Now they go directly to the LLM for a proper, focused, helpful response.
     */
    if (intent === "general_wellness") {
      const advice = await generateWellnessAdvice(wellnessTopic, rawUserMessage);
      await saveSession(sessionId, state);
      if (advice) {
        return streamText(advice + TRIAGE_DISCLAIMER);
      }
      // Fallback if LLM unavailable
      return streamText(
        "I'd be happy to help with health and wellness information. Could you tell me a bit more about what you're looking for — for example, are you looking for tips on stress, sleep, nutrition, or something else?"
      );
    }

    /* ---------- Condition follow-up ----------
     * Handles post-triage questions about a diagnosed condition.
     * Trigger if: intent is condition_followup, OR the LLM resolved a pronoun,
     * OR we have a lastDiagnosis and intent is info_query/unknown (edge case safety net).
     */
    const isFollowUp =
      intent === "condition_followup" ||
      (resolvedCondition && state.lastDiagnosis) ||
      (state.lastDiagnosis && (intent === "info_query" || intent === "unknown"));

    if (isFollowUp) {
      const conditionName = resolvedCondition || state.lastDiagnosis?.condition;
      if (conditionName) {
        const advice = await generateContextualAdvice(conditionName, rawUserMessage);
        if (advice) {
          await saveSession(sessionId, state);
          return streamText(advice + TRIAGE_DISCLAIMER);
        }
      }
      // Fall through to info_query if generateContextualAdvice fails
    }

    /* ---------- Info query ---------- */
    if (intent === "info_query") {
      const ret = await retrieveCondition(rawUserMessage, {
        symptoms: llmSymptoms,
        slots: llmSlots,
        topK: 3
      });

      if (!ret?.diseases?.length) {
        await saveSession(sessionId, state);
        return streamText("I couldn't find concise info for that query. Could you rephrase or mention the condition name?");
      }

      const bullets = ret.diseases.map(d => {
        const doc = d.disease;
        const conf = Math.round(d.score * 100);
        return "• " + doc.condition + " — " + conf + "% match\n  " + doc.description;
      }).join("\n\n");

      await saveSession(sessionId, state);
      return streamText(
        "Here are the top matches:\n\n" + bullets +
        "\n\nIf you'd like triage for your symptoms, say \"I have...\" and describe them." +
        TRIAGE_DISCLAIMER
      );
    }

    /* ---------- Triage: waiting for yes/no answer ---------- */
    if (state.mode === "triage" && state.lastAskedSymptom) {
      let yn = yes_no;
      if (yn === "UNKNOWN" && /^\d+$/.test(rawUserMessage.trim())) {
        yn = parseInt(rawUserMessage.trim()) > 0 ? "YES" : "NO";
      }

      updateProbabilities(state.diseases, state.lastAskedSymptom, yn);
      state.askedSymptoms.add(state.lastAskedSymptom);
      if (yn === "YES") state.confirmedSymptoms.add(state.lastAskedSymptom);
      state.questionsAsked = (state.questionsAsked || 0) + 1;
      state.lastAskedSymptom = null;

      const topScore = state.diseases[0]?.score || 0;

      if (topScore >= STOP_CONFIDENCE || state.questionsAsked >= MAX_QUESTIONS) {
        const top = state.diseases[0];
        const confidencePercent = Math.round((top.score || 0) * 100);
        const confirmed = Array.from(state.confirmedSymptoms);

        const runner_up = state.diseases[1]
          ? "\nAlso considered: " + state.diseases[1].disease.condition + " (" + Math.round(state.diseases[1].score * 100) + "%)"
          : "";

        const summary = [
          "📋 Triage Summary",
          "Most likely: " + top.disease.condition + " (" + confidencePercent + "% confidence)" + runner_up,
          "Description: " + (top.disease.description || "—"),
          "Severity: " + (top.disease.severity || "Unknown"),
          "Confirmed symptoms: " + (confirmed.length ? confirmed.join(", ") : "None clearly confirmed"),
          "Recommended next step: Schedule a consultation with a healthcare professional for evaluation and testing.",
          "💬 Feel free to ask me follow-up questions about " + top.disease.condition + " — such as diet, treatment options, or recovery tips."
        ].join("\n\n");

        const diagnosisToKeep = {
          condition: top.disease.condition,
          description: top.disease.description || "",
          severity: top.disease.severity || "Unknown"
        };

        await saveSession(sessionId, { ...freshState(), lastDiagnosis: diagnosisToKeep });
        return streamText(summary + TRIAGE_DISCLAIMER);
      }

      const nextSymptom = pickMostInformativeSymptom(state.diseases, state.askedSymptoms);
      if (!nextSymptom) {
        const top = state.diseases[0];
        const conf = Math.round((top.score || 0) * 100);
        const diagnosisToKeep = {
          condition: top.disease.condition,
          description: top.disease.description || "",
          severity: top.disease.severity || "Unknown"
        };
        await saveSession(sessionId, { ...freshState(), lastDiagnosis: diagnosisToKeep });
        return streamText(
          "Based on your answers, the most likely condition is " + top.disease.condition + " (" + conf + "%).\n\n" +
          "Please consult a healthcare professional for a proper evaluation." +
          TRIAGE_DISCLAIMER
        );
      }

      state.lastAskedSymptom = nextSymptom;
      await saveSession(sessionId, state);
      return streamText(questionTextForSymptom(nextSymptom));
    }

    /* ---------- Symptom intake ---------- */
    if (intent === "symptom_intake" || (state.mode === "idle" && rawUserMessage.length > 10)) {
      state.slots = { ...(state.slots || {}), ...(llmSlots || {}) };
      state.symptomsText = rawUserMessage;
      state.lastDiagnosis = null; // clear previous context on new intake

      const ret = await retrieveCondition(rawUserMessage, {
        symptoms: llmSymptoms,
        slots: state.slots,
        topK: 6
      });

      if (!ret?.diseases?.length) {
        state.mode = "idle";
        await saveSession(sessionId, state);
        return streamText(
          "I couldn't map those symptoms to likely conditions. Could you describe additional symptoms, or mention where it hurts?"
        );
      }

      let entries = ret.diseases.map(d => ({
        disease: d.disease,
        symptomProb: d.symptomProb,
        semanticSim: d.semanticSim,
        score: Math.max(d.score || 0, 0.0001)
      }));
      const total = entries.reduce((s, e) => s + e.score, 0) || 1;
      entries.forEach(e => (e.score = e.score / total));

      state.diseases = entries;
      state.mode = "triage";
      state.askedSymptoms = new Set();
      state.confirmedSymptoms = new Set();
      state.questionsAsked = 0;

      const nextSymptom = pickMostInformativeSymptom(state.diseases, state.askedSymptoms);
      if (!nextSymptom) {
        const top = entries[0].disease;
        const fallbackQ = top.followups?.[0] || "Can you describe your symptoms in more detail or rate their severity?";
        state.lastAskedSymptom = null;
        await saveSession(sessionId, state);
        return streamText(fallbackQ);
      }

      state.lastAskedSymptom = nextSymptom;
      await saveSession(sessionId, state);
      return streamText(questionTextForSymptom(nextSymptom));
    }

    /* ---------- Fallback ---------- */
    await saveSession(sessionId, state);
    return streamText(
      "Hi — tell me your symptoms (e.g., \"I have fever and cough\"), or ask about a condition like \"What is pneumonia?\", or ask for wellness tips like \"How can I improve my sleep?\"."
    );
  } catch (err) {
    console.error("route error:", err);
    return streamText("Something went wrong on our end. Please try again.");
  }
}
