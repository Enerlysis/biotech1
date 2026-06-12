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

    // Use a model with Responses API + web_search support.
    // gpt-4.1 is safer if your account does not have GPT-5 model access.
    const model = "gpt-4.1";

    const today = new Date().toISOString().slice(0, 10);

    const prompt = `
You are a biotech regulatory-catalyst research assistant.

Your most important job:
Find the most accurate PDUFA date for the company below.

Company/ticker:
- Ticker: ${ticker || "unknown"}
- Company: ${company || "unknown"}
- Benchmark/index: ${benchmark || "unknown"}
- User notes: ${extraNotes || "none"}
- Today: ${today}

Use web search. Do not answer from memory.

PDUFA source hierarchy:
1. Highest confidence: company press release / investor relations page saying FDA accepted NDA/BLA and assigned a PDUFA target action date.
2. Highest confidence: SEC filing, especially 8-K, 10-Q, 10-K, S-1, 424B, mentioning PDUFA target action date.
3. High confidence: FDA page/document if it directly confirms an action/review date.
4. Medium confidence: reputable news source quoting the company or FDA.
5. Low confidence: third-party FDA/PDUFA calendar only.
6. Do not accept social media, forums, Stocktwits, Reddit, or unsourced calendars as primary evidence.

Search for phrases like:
- "${ticker} PDUFA date"
- "${company} PDUFA target action date"
- "${ticker} FDA accepted NDA PDUFA"
- "${ticker} FDA accepted BLA PDUFA"
- "${company} target action date FDA"
- "${company} review goal date FDA"
- "${company} NDA accepted for review"
- "${company} BLA accepted for review"
- "${ticker} 8-K PDUFA"

Strict rules:
- Do NOT invent a PDUFA date.
- If no exact date is found from a reliable source, set pdufa.date to null.
- If only a month/quarter is found, put it in pdufa.status, but keep pdufa.date null.
- If the date is in the past, still report it, but mark status as "past date; check whether FDA decision already occurred".
- If different sources conflict, choose the newest/highest-quality source and mention the conflict.
- Every PDUFA claim must have a source URL.
- Return only valid JSON. No markdown.

After PDUFA, provide a basic biotech score, but do not overstate confidence if financials/data are incomplete.

Use this exact JSON shape:
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
    "application_type": "NDA, BLA, sNDA, sBLA, resubmission, or null",
    "review_type": "standard, priority, accelerated approval, unknown, or null",
    "status": "string",
    "evidence_summary": "string",
    "primary_source_title": "string or null",
    "primary_source_url": "string or null",
    "source_quality": "company_press_release, sec_filing, fda, reputable_news, third_party_calendar, none",
    "confidence_0_100": number
  },
  "next_catalysts": [
    {
      "catalyst": "string",
      "expected_timing": "string",
      "importance": "string",
      "risk": "string",
      "source_url": "string or null"
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
      "source_type": "company_press_release, sec_filing, fda, clinicaltrials, reputable_news, third_party_calendar, other",
      "why_it_matters": "string"
    }
  ],
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
        input: prompt,
        tools: [
          {
            type: "web_search",
            search_context_size: "medium"
          }
        ],
        tool_choice: "required",
        text: {
          format: {
            type: "json_object"
          }
        }
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
      analysis = parseJsonMaybe(outputText);
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
