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

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found in model output.");
    return JSON.parse(match[0]);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST /api/analyze." });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY in Vercel Environment Variables.",
      fix: "In Vercel, go to Project → Settings → Environment Variables → add OPENAI_API_KEY → Redeploy."
    });
  }

  try {
    const body = req.body || {};

    const ticker = safeString(body.ticker, 40).toUpperCase();
    const company = safeString(body.company, 120);
    const benchmark = safeString(body.index || body.benchmark, 80);
    const extraNotes = safeString(body.extraNotes, 1000);

    if (!ticker && !company) {
      return res.status(400).json({
        error: "Please enter at least a ticker or company name."
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    // You can change this in Vercel Environment Variables.
    // Example:
    // OPENAI_MODEL=gpt-5.5
    const model = const model = "gpt-4.1";

    const prompt = `
You are a biotech equity research assistant. This is for research only, not personalized financial advice.

Analyze this biotech company:
- Ticker: ${ticker || "unknown"}
- Company: ${company || "unknown"}
- Benchmark/index: ${benchmark || "unknown"}
- User notes: ${extraNotes || "none"}
- Today: ${today}

Use web search. Prefer reliable sources:
- company press releases
- SEC EDGAR filings
- FDA pages
- ClinicalTrials.gov
- reputable financial/news sources

Return JSON only. Do not use markdown.

Required tasks:
1. Identify whether there is an upcoming PDUFA date. Do not invent one. If not found, use null.
2. Identify next catalysts: PDUFA, AdCom, NDA/BLA, Phase 2/3 readout, IND, financing risk, earnings, data readout.
3. Score using:
   - clinical_data_quality, 0-10
   - regulatory_path, 0-10
   - financial_health_dilution, 0-10
   - valuation_risk_reward, 0-10
   - commercial_potential, 0-10
   - management_governance, 0-10
   - liquidity_technical_risk, 0-10
4. Overall score must use these weights:
   - clinical data quality: 25%
   - regulatory path: 20%
   - financial health/dilution: 17.5%
   - valuation/risk-reward: 17.5%
   - commercial potential: 10%
   - management/governance: 5%
   - liquidity/technical risk: 5%
5. Penalize:
   - severe dilution
   - low cash runway
   - reverse splits
   - toxic financing
   - promotional microcap behavior
   - weak trial design
   - unclear evidence
6. Include URLs in sources.
7. Be transparent when information is missing.
8. Do not say "buy", "sell", or "guaranteed".

Return exactly this JSON shape:
{
  "ticker": "string",
  "company_name": "string",
  "benchmark_index": "string",
  "overall_score_0_100": number,
  "verdict": "string, no buy/sell instruction",
  "confidence_0_100": number,
  "pdufa": {
    "date": "YYYY-MM-DD or null",
    "drug": "string or null",
    "indication": "string or null",
    "status": "string",
    "evidence_summary": "string",
    "confidence_0_100": number
  },
  "next_catalysts": [
    {
      "catalyst": "string",
      "expected_timing": "string",
      "importance": "string",
      "risk": "string"
    }
  ],
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
  "sources": [
    {
      "title": "string",
      "url": "string",
      "why_it_matters": "string"
    }
  ],
  "disclaimer": "string"
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
        tools: [
          {
            type: "web_search",
            search_context_size: "low"
          }
        ],
        tool_choice: "auto",
        input: prompt,
        text: {
          format: {
            type: "json_object"
          }
        }
      })
    });

    const raw = await response.json();

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
      analysis = parseJsonMaybe(outputText);
    } catch (e) {
      return res.status(502).json({
        error: "Could not parse JSON from model output.",
        detail: e.message,
        outputText
      });
    }

    return res.status(200).json(analysis);
  } catch (error) {
    return res.status(500).json({
      error: "Server function failed.",
      detail: error?.message || String(error)
    });
  }
}
