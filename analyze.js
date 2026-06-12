import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const model = process.env.OPENAI_MODEL || "gpt-5.5";

function safeString(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 300);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  try {
    const body = req.body || {};
    const ticker = safeString(body.ticker);
    const index = safeString(body.index || body.benchmark);
    const company = safeString(body.company);
    const extraNotes = safeString(body.extraNotes);

    if (!ticker && !company) {
      return res.status(400).json({ error: "Please provide at least a ticker or company name." });
    }

    const prompt = `
You are a biotech equity research assistant. Analyze this biotech company for research purposes only.
Do NOT provide personalized financial advice. Do NOT say "buy", "sell", or "guaranteed".
Return a structured JSON object only.

Inputs:
- Ticker: ${ticker || "unknown"}
- Company: ${company || "unknown"}
- Benchmark/index: ${index || "unknown"}
- User notes: ${extraNotes || "none"}

Tasks:
1. Search the web for the latest reliable information.
2. Find whether there is an upcoming PDUFA date. Prefer company press releases, SEC filings, FDA pages, and reputable finance/news sources. If not found, return null and explain uncertainty.
3. Identify major upcoming catalysts: PDUFA, Phase 2/3 readout, NDA/BLA filing, AdCom, IND, financing risk, earnings.
4. Score the company using these weights:
   - clinical_data_quality: 25
   - regulatory_path: 20
   - financial_health_dilution: 17.5
   - valuation_risk_reward: 17.5
   - commercial_potential: 10
   - management_governance: 5
   - liquidity_technical_risk: 5
5. Penalize severe dilution, weak runway, promotional microcap behavior, unclear data, and lack of reliable evidence.
6. Include source URLs for every major claim.
7. Be transparent about confidence and missing data.

Important:
- FDA designations are not approval guarantees.
- If the company is a microcap/low-liquidity stock, flag manipulation and dilution risk.
- Do not fabricate PDUFA dates.
- Today is ${new Date().toISOString().slice(0, 10)}.
`;

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        ticker: { type: "string" },
        company_name: { type: "string" },
        benchmark_index: { type: "string" },
        overall_score_0_100: { type: "number" },
        verdict: { type: "string", description: "Research verdict without buy/sell language." },
        confidence_0_100: { type: "number" },
        pdufa: {
          type: "object",
          additionalProperties: false,
          properties: {
            date: { type: ["string", "null"], description: "YYYY-MM-DD if known, otherwise null." },
            drug: { type: ["string", "null"] },
            indication: { type: ["string", "null"] },
            status: { type: "string" },
            evidence_summary: { type: "string" },
            confidence_0_100: { type: "number" }
          },
          required: ["date", "drug", "indication", "status", "evidence_summary", "confidence_0_100"]
        },
        next_catalysts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              catalyst: { type: "string" },
              expected_timing: { type: "string" },
              importance: { type: "string" },
              risk: { type: "string" }
            },
            required: ["catalyst", "expected_timing", "importance", "risk"]
          }
        },
        component_scores: {
          type: "object",
          additionalProperties: false,
          properties: {
            clinical_data_quality: { type: "number" },
            regulatory_path: { type: "number" },
            financial_health_dilution: { type: "number" },
            valuation_risk_reward: { type: "number" },
            commercial_potential: { type: "number" },
            management_governance: { type: "number" },
            liquidity_technical_risk: { type: "number" }
          },
          required: [
            "clinical_data_quality",
            "regulatory_path",
            "financial_health_dilution",
            "valuation_risk_reward",
            "commercial_potential",
            "management_governance",
            "liquidity_technical_risk"
          ]
        },
        red_flags: {
          type: "array",
          items: { type: "string" }
        },
        positive_factors: {
          type: "array",
          items: { type: "string" }
        },
        explanation: { type: "string" },
        missing_information: {
          type: "array",
          items: { type: "string" }
        },
        sources: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              why_it_matters: { type: "string" }
            },
            required: ["title", "url", "why_it_matters"]
          }
        },
        disclaimer: { type: "string" }
      },
      required: [
        "ticker",
        "company_name",
        "benchmark_index",
        "overall_score_0_100",
        "verdict",
        "confidence_0_100",
        "pdufa",
        "next_catalysts",
        "component_scores",
        "red_flags",
        "positive_factors",
        "explanation",
        "missing_information",
        "sources",
        "disclaimer"
      ]
    };

    const response = await openai.responses.create({
      model,
      input: prompt,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      text: {
        format: {
          type: "json_schema",
          name: "biotech_stock_analysis",
          strict: true,
          schema
        }
      }
    });

    const jsonText = response.output_text;
    let analysis;

    try {
      analysis = JSON.parse(jsonText);
    } catch (e) {
      return res.status(502).json({
        error: "Model response was not valid JSON.",
        raw: jsonText
      });
    }

    return res.status(200).json(analysis);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Analysis failed.",
      detail: error?.message || String(error)
    });
  }
}