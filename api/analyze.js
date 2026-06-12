function safeString(value, max = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text === "string") chunks.push(c.text);
          if (typeof c.output_text === "string") chunks.push(c.output_text);
        }
      }
    }
  }

  return chunks.join("\n").trim();
}

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      return res.status(200).json({ ok: true });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST /api/analyze." });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Missing OPENAI_API_KEY in Vercel."
      });
    }

    const body = req.body || {};
    const ticker = safeString(body.ticker, 40).toUpperCase();
    const company = safeString(body.company, 120);
    const benchmark = safeString(body.index || body.benchmark, 80);
    const extraNotes = safeString(body.extraNotes, 1000);

    if (!ticker && !company) {
      return res.status(400).json({
        error: "Please enter a ticker or company name."
      });
    }

    const model = "gpt-4.1";

    const prompt = `
You are a biotech stock research assistant. This is not financial advice.

Analyze:
Ticker: ${ticker || "unknown"}
Company: ${company || "unknown"}
Benchmark/index: ${benchmark || "unknown"}
Extra notes: ${extraNotes || "none"}

Return ONLY valid JSON. No markdown.

Use this exact JSON shape:
{
  "ticker": "string",
  "company_name": "string",
  "benchmark_index": "string",
  "overall_score_0_100": number,
  "verdict": "string",
  "confidence_0_100": number,
  "pdufa": {
    "date": null,
    "drug": null,
    "indication": null,
    "status": "Not verified in this basic version",
    "evidence_summary": "Live web verification is disabled in this test version.",
    "confidence_0_100": 20
  },
  "next_catalysts": [],
  "component_scores": {
    "clinical_data_quality": number,
    "regulatory_path": number,
    "financial_health_dilution": number,
    "valuation_risk_reward": number,
    "commercial_potential": number,
    "management_governance": number,
    "liquidity_technical_risk": number
  },
  "red_flags": ["string"],
  "positive_factors": ["string"],
  "explanation": "string",
  "missing_information": ["string"],
  "sources": [],
  "disclaimer": "Research only, not financial advice."
}
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: prompt
      })
    });

    const rawText = await response.text();

    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({
        error: "OpenAI returned non-JSON response.",
        rawText
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: "OpenAI API error.",
        status: response.status,
        detail: raw?.error?.message || raw
      });
    }

    const outputText = extractOutputText(raw);

    if (!outputText) {
      return res.status(502).json({
        error: "OpenAI returned no output text.",
        raw
      });
    }

    let analysis;
    try {
      analysis = JSON.parse(outputText);
    } catch (e) {
      return res.status(502).json({
        error: "Model did not return valid JSON.",
        outputText
      });
    }

    return res.status(200).json(analysis);
  } catch (error) {
    return res.status(500).json({
      error: "Server function crashed.",
      detail: error?.message || String(error)
    });
  }
}
