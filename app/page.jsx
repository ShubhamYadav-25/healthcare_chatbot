"use client";
import { useState, useRef, useEffect } from "react";

const QUICK_ACTIONS = [
  { icon: "🌡️", label: "Check symptoms", prompt: "I'd like help understanding some symptoms I'm experiencing." },
  { icon: "💊", label: "Medication info", prompt: "Can you explain common medication interactions and side effects?" },
  { icon: "🧠", label: "Mental wellness", prompt: "I've been feeling stressed and anxious. Can you share some mental wellness tips?" },
  { icon: "🏥", label: "Emergency guide", prompt: "What are signs of a medical emergency I should know about?" },
  { icon: "🥦", label: "Nutrition tips", prompt: "Can you give me evidence-based nutrition tips for a healthier diet?" },
  { icon: "😴", label: "Sleep health", prompt: "How can I improve my sleep quality? I've been having trouble sleeping." },
];

/* ---------- Session ID helpers ---------- */
// FIX: Previously the frontend never sent a sessionId, so the backend fell through
// to "default" and ALL users shared one triage session. Now we generate a UUID once
// per browser, persist it in localStorage, and send it as a top-level body field.
function getOrCreateSessionId() {
  if (typeof window === "undefined") return "ssr-placeholder";
  let id = localStorage.getItem("mediassist_session_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("mediassist_session_id", id);
  }
  return id;
}

function rotateSessionId() {
  if (typeof window === "undefined") return;
  const newId = crypto.randomUUID();
  localStorage.setItem("mediassist_session_id", newId);
  return newId;
}

/* ---------- Sub-components ---------- */
function TypingDots() {
  return (
    <div style={{ display: "flex", gap: "5px", padding: "4px 0", alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{
          width: 8, height: 8, borderRadius: "50%",
          background: "var(--teal-light)",
          animation: "bounce 1.2s ease-in-out infinite",
          animationDelay: `${i * 0.2}s`,
        }} />
      ))}
      <style>{`@keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }`}</style>
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === "user";
  // Improved emergency detection: check for the actual marker we set in the backend
  const isEmergency =
    msg.content?.includes("⚠️") ||
    msg.content?.toLowerCase().includes("emergency services") ||
    msg.content?.toLowerCase().includes("emergency department");

  return (
    <div style={{
      display: "flex",
      flexDirection: isUser ? "row-reverse" : "row",
      gap: 12,
      alignItems: "flex-start",
      animation: "fadeUp 0.3s ease",
    }}>
      <style>{`@keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }`}</style>

      <div style={{
        width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
        background: isUser ? "var(--teal)" : "linear-gradient(135deg, #2d8a6e, #4aac8a)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16, color: "white", fontWeight: 600,
        boxShadow: "0 2px 8px rgba(45,138,110,0.2)",
      }}>
        {isUser ? "U" : "M"}
      </div>

      <div style={{
        maxWidth: "72%",
        background: isUser ? "var(--teal)" : isEmergency ? "#fff5f5" : "var(--surface)",
        color: isUser ? "white" : isEmergency ? "#c0392b" : "var(--text-primary)",
        borderRadius: isUser ? "18px 4px 18px 18px" : "4px 18px 18px 18px",
        padding: "12px 16px",
        boxShadow: isEmergency
          ? "0 0 0 2px #e84040, 0 4px 16px rgba(232,64,64,0.15)"
          : "var(--shadow)",
        border: isEmergency ? "none" : isUser ? "none" : "1px solid var(--border)",
        lineHeight: 1.65, fontSize: 15,
      }}>
        {msg.loading ? <TypingDots /> : (
          <div style={{ whiteSpace: "pre-wrap" }}>
            {isEmergency && (
              <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>
                🚨 EMERGENCY ALERT
              </div>
            )}
            {msg.content}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Main component ---------- */
export default function HealthChatbot() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [error, setError] = useState("");
  // FIX: Track sessionId in state so it can be updated on reset without a full page reload
  const [sessionId, setSessionId] = useState("initializing");
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Initialize sessionId on client (can't access localStorage during SSR)
  useEffect(() => {
    setSessionId(getOrCreateSessionId());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async (text) => {
    const content = (text || input).trim();
    if (!content || loading) return;

    setInput("");
    setShowWelcome(false);
    setError("");

    const userMsg = { role: "user", content };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "", loading: true }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // FIX: sessionId is now a top-level field, not buried inside messages[0].
          // The backend reads body.sessionId directly.
          sessionId,
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const data = JSON.parse(line.slice(6));
              assistantText += data.text;
              setMessages((prev) => [
                ...prev.slice(0, -1),
                { role: "assistant", content: assistantText, loading: false },
              ]);
            } catch {}
          }
        }
      }
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleReset = async () => {
    if (loading) return;

    const confirmReset = window.confirm("Start a new conversation?");
    if (!confirmReset) return;

    // FIX: Rotate to a new sessionId so the backend creates a fresh session.
    // The old sessionId's session will naturally expire via the MongoDB TTL index.
    const newId = rotateSessionId();
    setSessionId(newId);

    setMessages([]);
    setInput("");
    setShowWelcome(true);
    setError("");
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      background: "linear-gradient(160deg, #e8f5f0 0%, #fafcfb 40%, #f0f9f4 100%)",
    }}>
      {/* Header */}
      <header style={{
        padding: "0 24px", height: 64,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "rgba(255,255,255,0.85)", backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border)", position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 12,
            background: "linear-gradient(135deg, var(--teal-dark), var(--teal-light))",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18, boxShadow: "0 4px 12px rgba(45,138,110,0.3)",
          }}>🩺</div>
          <div>
            <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 18, color: "var(--teal-dark)", lineHeight: 1.1 }}>
              MediAssist
            </div>
            <div style={{ fontSize: 11, color: "var(--teal)", fontWeight: 500, letterSpacing: "0.05em" }}>
              AI HEALTH COMPANION
            </div>
          </div>
        </div>
        {/* FIX: was showing "Phi-3 Mini" which was neither the model being used nor
            connected to the actual stack. Now accurately reflects Groq + Llama 3. */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "var(--mint)", padding: "5px 12px",
          borderRadius: 99, fontSize: 12, color: "var(--teal)", fontWeight: 500,
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%", background: "#3fc98a",
            display: "inline-block", animation: "pulse 2s infinite",
          }} />
          Llama 3 · Groq
          <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }`}</style>
        </div>
      </header>

      {/* Disclaimer */}
      <div style={{
        background: "linear-gradient(90deg, #fffbeb, #fef3c7)",
        borderBottom: "1px solid #fde68a",
        padding: "8px 24px", fontSize: 12, color: "#92400e",
        textAlign: "center", fontWeight: 500,
      }}>
        ⚕️ MediAssist provides general health information only — not medical diagnosis or treatment.
        Always consult a qualified healthcare professional.
      </div>

      {/* Chat Area */}
      <main style={{
        flex: 1, display: "flex", flexDirection: "column",
        maxWidth: 760, width: "100%", margin: "0 auto", padding: "0 16px",
      }}>
        {/* Welcome Screen */}
        {showWelcome && messages.length === 0 && (
          <div style={{ padding: "40px 0 24px", animation: "fadeUp 0.5s ease" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={{
                fontFamily: "'Fraunces', serif", fontSize: 36, fontWeight: 700,
                color: "var(--teal-dark)", marginBottom: 8,
              }}>
                How can I help you today?
              </div>
              <p style={{ color: "var(--text-secondary)", fontSize: 15, maxWidth: 480, margin: "0 auto" }}>
                Ask me about symptoms, medications, wellness tips, or anything health-related.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
              {QUICK_ACTIONS.map((action) => (
                <button key={action.label} onClick={() => sendMessage(action.prompt)} style={{
                  background: "var(--surface)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", padding: "16px", cursor: "pointer",
                  textAlign: "left", transition: "all 0.2s", boxShadow: "var(--shadow)",
                }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "translateY(-2px)";
                    e.currentTarget.style.boxShadow = "var(--shadow-lg)";
                    e.currentTarget.style.borderColor = "var(--teal-light)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "translateY(0)";
                    e.currentTarget.style.boxShadow = "var(--shadow)";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>{action.icon}</div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>
                    {action.label}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div style={{
            background: "#fff5f5", border: "1px solid #feb2b2", borderRadius: 12,
            padding: "12px 16px", color: "#c53030", fontSize: 14,
            margin: "12px 0", display: "flex", justifyContent: "space-between",
          }}>
            ⚠️ {error}
            <button onClick={() => setError("")} style={{ background: "none", border: "none", cursor: "pointer", color: "#c53030" }}>✕</button>
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, padding: "24px 0" }}>
          {messages.map((msg, i) => <Message key={i} msg={msg} />)}
          <div ref={bottomRef} />
        </div>

        {/* Floating Reset Button */}
        <button
          onClick={handleReset}
          style={{
            position: "fixed", bottom: 90, right: 24, width: 56, height: 56, borderRadius: "50%",
            border: "none", cursor: "pointer", background: "linear-gradient(135deg, var(--teal), var(--teal-light))",
            color: "white", fontSize: 22, boxShadow: "0 8px 24px rgba(45,138,110,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
            transition: "all 0.25s ease"
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.1)";
            e.currentTarget.style.boxShadow = "0 12px 30px rgba(45,138,110,0.45)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
            e.currentTarget.style.boxShadow = "0 8px 24px rgba(45,138,110,0.35)";
          }}
          title="Start new conversation"
        >
          ⟳
        </button>
      </main>

      {/* Input Area */}
      <div style={{
        background: "rgba(255,255,255,0.9)", backdropFilter: "blur(12px)",
        borderTop: "1px solid var(--border)", padding: "16px 24px 20px",
        position: "sticky", bottom: 0,
      }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{
            flex: 1, background: "var(--surface)", border: "1.5px solid var(--border)",
            borderRadius: 16, padding: "10px 16px",
            boxShadow: "0 2px 12px rgba(45,138,110,0.06)", transition: "border-color 0.2s",
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask me about symptoms, medications, health tips…"
              rows={1}
              disabled={loading}
              style={{
                width: "100%", border: "none", outline: "none",
                resize: "none", fontFamily: "'DM Sans', sans-serif",
                fontSize: 15, color: "var(--text-primary)",
                background: "transparent", lineHeight: 1.5, maxHeight: 120, overflowY: "auto",
              }}
              onInput={(e) => {
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
            />
          </div>
          <button
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            style={{
              width: 46, height: 46, borderRadius: 14, border: "none",
              background: loading || !input.trim()
                ? "var(--border)"
                : "linear-gradient(135deg, var(--teal), var(--teal-light))",
              color: "white", cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18, flexShrink: 0, transition: "all 0.2s",
              boxShadow: loading || !input.trim() ? "none" : "0 4px 12px rgba(45,138,110,0.35)",
            }}>
            {loading ? "⏳" : "➤"}
          </button>
        </div>
        <p style={{
          maxWidth: 760, margin: "10px auto 0",
          fontSize: 11, color: "var(--text-muted)", textAlign: "center",
        }}>
          Powered by Llama 3 via Groq · 🚨 Emergencies: call <strong>911</strong>
        </p>
      </div>
    </div>
  );
}