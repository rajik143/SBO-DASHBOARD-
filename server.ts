import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// SBO Realtime Database URL
const SBO_DATABASE_URL = "https://sbo-database-default-rtdb.firebaseio.com/sbo_data.json";

// Simple in-memory caching with 30-sec TTL
let sboCache: any = null;
let sboCacheTime = 0;

async function getSBOData() {
  const now = Date.now();
  if (sboCache && (now - sboCacheTime < 30000)) {
    return sboCache;
  }
  try {
    const response = await fetch(SBO_DATABASE_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch database: ${response.statusText}`);
    }
    const rawData = await response.json();
    // Support nested structure or root structure
    sboCache = rawData.sbo_data || rawData;
    sboCacheTime = now;
    return sboCache;
  } catch (error) {
    console.error("Error fetching SBO database:", error);
    if (sboCache) return sboCache; // Return stale fallback if server fails
    throw error;
  }
}

// REST API endpoint: Retrieve SBO Data
app.get("/api/sbo-data", async (req, res) => {
  try {
    const data = await getSBOData();
    res.json({ sbo_data: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to fetch SBO data." });
  }
});

// REST API endpoint: SBO Assistant Chat with Gemini 3.5 Flash
app.post("/api/chat", express.json({ limit: "50mb" }), async (req, res) => {
  const { message, history, imageBase64 } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.json({
      reply: "Vanakkam! Ennala ipo full interactive service thara mudiyala, yenna server key configuration set panna padala. (Gemini API Key is missing in workspace Secrets.)"
    });
  }

  try {
    const data = await getSBOData();
    const cleanData = JSON.stringify(data);

    // Initialize named parameterized GoogleGenAI client (Recommended and secure server-side)
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    const parts: any[] = [{ text: message }];
    if (imageBase64) {
      const mimeType = imageBase64.split(";")[0].split(":")[1];
      const data = imageBase64.split(",")[1];
      parts.push({ inlineData: { data, mimeType } });
    }

    const geminiContents = [
      ...(history || []).map((msg: any) => ({
        role: msg.role === "model" ? "model" : "user",
        parts: [{ text: msg.text }]
      })),
      { role: "user", parts }
    ];

    const systemInstruction = `You are the SBO Assistant, a helpful and smart database concierge for SBO (School of Business Organization) administrators.
You have absolute access to the SBO staff database provided below in JSON format.
Your job is to answer the administrator's queries about staff, wallets, tasks, approvals, nominees, and balances accurately and in a friendly, conversational manner.
You should support English, Tamil, and Tamil-English (Tanglish) naturally!

SBO STAFF DATABASE:
${cleanData}

When answering queries:
- Be neat and structure with bullet points or simple tables if showing list data.
- Maintain administrator privacy but give direct, precise, non-evasive data answers.
- Speak professionally but allow local Tamil/Tanglish phrases to make the interface extremely native, warm, and engaging.
- If the user asks for help or general actions, guide them through.
`;

    const makeFetchRequest = async (model: string) => {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: geminiContents,
          systemInstruction: { parts: [{ text: systemInstruction }] }
        })
      });
      if (!resp.ok) {
        if (resp.status === 404) return null; // Model not found
        const errText = await resp.text();
        throw new Error(`Gemini API failed (${model}): ${errText}`);
      }
      return resp.json();
    };

    let responseData = await makeFetchRequest("gemini-3.1-flash-lite");
    if (!responseData) {
      console.log("gemini-3.1-flash-lite not found, falling back to gemini-2.5-flash...");
      responseData = await makeFetchRequest("gemini-2.5-flash");
      if (!responseData) throw new Error("Fallback model gemini-2.5-flash also not found.");
    }

    const replyText = responseData.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";
    res.json({ reply: replyText });
  } catch (error: any) {
    console.error("Gemini API error:", error);
    res.status(500).json({ error: error.message || "Failed to generate AI response." });
  }
});

// Bind Vite developer Server middleware or serve static built files
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in development mode...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in production mode...");
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server actively running on host http://0.0.0.0:${PORT}`);
  });
}

startServer();
