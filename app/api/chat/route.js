import { retrieveCondition, isEmergency } from "./rag";

const MODEL = "llama-3.1-8b-instant";

// In-memory triage state (replace with DB/Redis in production)
global.triageState = global.triageState || {};

function streamText(text) {
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ text })}\n\n`
        )
      );
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

export async function POST(request) {
  try {
    const { messages } = await request.json();
    const userMessage =
      messages[messages.length - 1]?.content || "";

    const lowerMessage = userMessage.toLowerCase();

    // 🚨 Emergency override
    if (isEmergency(userMessage)) {
      return streamText(
        "⚠️ This may be a medical emergency. Please call your local emergency number immediately or go to the nearest emergency room."
      );
    }

    // 🆕 Reset triggers
    const resetTriggers = [
      "start over",
      "new problem",
      "another issue",
      "reset"
    ];

    const sessionId = "default";

    if (!global.triageState) {
      global.triageState = {};
    }

    if (!global.triageState[sessionId]) {
      global.triageState[sessionId] = {
        activeDoc: null,
        questionIndex: 0,
        confirmedSymptoms: [],
        ragConfidence: 0,
        mode: "idle"
      };
    }

    const state = global.triageState[sessionId];

    // 🔁 Manual reset
    if (resetTriggers.some(t => lowerMessage.includes(t))) {
      state.activeDoc = null;
      state.questionIndex = 0;
      state.confirmedSymptoms = [];
      state.mode = "idle";

      return streamText(
        "Sure. Please tell me what symptoms you are experiencing."
      );
    }

    // 🔎 STEP 1 — Detect condition if idle
    if (!state.activeDoc) {
      const ragResult = await retrieveCondition(userMessage);

      if (ragResult?.doc && ragResult.confidence > 0.3) {
        state.activeDoc = ragResult.doc;
        state.questionIndex = 0;
        state.confirmedSymptoms = [];
        state.ragConfidence = ragResult.confidence || 0;
        state.mode = "triage";

        const firstQuestion =
          state.activeDoc.followups[0];

        return streamText(firstQuestion);
      } 
      // No RAG match → General mode
      state.mode = "general";
    }

    // 🧠 STEP 2 — Deterministic follow-up flow
    if (state.mode === "triage" && state.activeDoc) {
      const doc = state.activeDoc;

      // Save YES answers
      if (lowerMessage.includes("yes")) {
        state.confirmedSymptoms.push(
          doc.followups[state.questionIndex]
        );
      }

      state.questionIndex++;

      // Ask next question if available
      if (state.questionIndex < doc.followups.length) {
        const nextQuestion =
          doc.followups[state.questionIndex];

        return streamText(nextQuestion);
      }

      // ✅ STEP 3 — Final Structured Summary
      const totalQuestions = doc.followups.length;
const confirmedCount = state.confirmedSymptoms.length;

const symptomScore =
  totalQuestions > 0
    ? confirmedCount / totalQuestions
    : 0;

const ragScore = state.ragConfidence || 0;

const finalConfidence =
  (ragScore * 0.4) + (symptomScore * 0.6);

const confidencePercent =
  Math.round(finalConfidence * 100);

const finalSummary = `
Summary:
Based on your responses, your symptoms may be consistent with ${doc.condition}.

Possible Causes:
- ${doc.description}

Risk Level:
${doc.severity}

Recommended Action:
Consider consulting a healthcare professional for proper evaluation and diagnosis.

Confidence Score:
${confidencePercent}% likelihood based on symptom matching and pattern similarity.

If you have another concern, please describe your symptoms.
`.trim();

      // Reset state for new conversation
      state.activeDoc = null;
      state.questionIndex = 0;
      state.confirmedSymptoms = [];
      state.mode = "idle";

      return streamText(finalSummary);
    }

    // 🔁 STEP 4 — General LLM fallback
    const fallbackResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0.4,
          max_tokens: 600,
          stream: true
        })
      }
    );

    if (!fallbackResponse.ok) {
      const error = await fallbackResponse.text();
      console.error("Groq API Error:", error);
      return streamText(
        "Sorry, something went wrong. Please try again."
      );
    }

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        const reader = fallbackResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, {
            stream: true
          });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (
              !trimmed ||
              trimmed === "data: [DONE]"
            )
              continue;
            if (!trimmed.startsWith("data:"))
              continue;

            try {
              const json = JSON.parse(
                trimmed.replace("data: ", "")
              );

              const text =
                json.choices?.[0]?.delta?.content;

              if (text) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      text
                    })}\n\n`
                  )
                );
              }
            } catch {}
          }
        }

        controller.enqueue(
          encoder.encode("data: [DONE]\n\n")
        );
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
  } catch (error) {
    console.error("Chat error:", error);
    return streamText(
      "Something went wrong. Please try again."
    );
  }
}