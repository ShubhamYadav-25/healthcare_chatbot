// rag.js

import clientPromise from "../../mongodb";

const symptomSynonyms = {
  tired: "fatigue",
  exhausted: "fatigue",
  thirsty: "thirst",
  peeing: "frequent urination",
  urinate: "frequent urination",
  dizzy: "dizziness",
  breathless: "shortness of breath"
};

export async function retrieveCondition(query) {
  const client = await clientPromise;
  const db = client.db("healthcare");
  const collection = db.collection("conditions");

  const lower = query.toLowerCase();

  const tokens = lower
  .replace(/[^\w\s]/g, "")
  .split(/\s+/)
  .map(token => {
    if (token.endsWith("s")) {
      return token.slice(0, -1);
    }
    return token;
  });

  const docs = await collection.find({
  keywords: { $in: tokens }
}).toArray();

  let bestDoc = null;
  let bestScore = 0;

  for (const doc of docs) {
    let score = 0;

    for (const keyword of doc.keywords) {
      const normalizedKeyword = keyword.toLowerCase();

      // Direct match
      if (lower.includes(normalizedKeyword)) {
        score += 3;
      }

      // Token match (partial word match)
      for (const token of tokens) {
        if (
          token.startsWith(normalizedKeyword) ||
          normalizedKeyword.startsWith(token)
        ) {
          score += 2;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestDoc = doc;
    }
  }

  return {
    doc: bestScore > 0 ? bestDoc : null,
    confidence: Math.min(1, bestScore / 8)
  };
}

export function isEmergency(text) {
  const emergencyKeywords = [
    "chest pain",
    "can't breathe",
    "unconscious",
    "stroke",
    "severe bleeding"
  ];

  const lower = text.toLowerCase();
  return emergencyKeywords.some(word => lower.includes(word));
}