function safeString(value, max = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function padCik(cik) {
  return String(cik).padStart(10, "0");
}

function secHeaders() {
  return {
    "User-Agent": process.env.CONTACT_EMAIL || "biotech-pdufa-analyzer contact@example.com",
    "Accept-Encoding": "gzip, deflate",
    "Accept": "application/json,text/html,*/*"
  };
}

async function fetchText(url) {
  const r = await fetch(url, { headers: secHeaders() });
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${url}`);
  return await r.text();
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: secHeaders() });
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${url}`);
  return await r.json();
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSnippets(text, keywords, windowSize = 650) {
  const snippets = [];
  const lower = text.toLowerCase();

  for (const keyword of keywords) {
    let pos = lower.indexOf(keyword.toLowerCase());
    while (pos !== -1 && snippets.length < 20) {
      const start = Math.max(0, pos - windowSize);
      const end = Math.min(text.length, pos + windowSize);
      const snippet = text.slice(start, end).trim();
      snippets.push(snippet);
      pos = lower.indexOf(keyword.toLowerCase(), pos + keyword.length);
    }
  }

  return [...new Set(snippets)];
}

function parseDateToIso(rawDate) {
  if (!rawDate) return null;

  const cleaned = rawDate.replace(/(\d+)(st|nd|rd|th)/gi, "$1").trim();
  const d = new Date(cleaned);

  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString().slice(0, 10);
}

function extractDatesFromSnippet(snippet) {
  const months =
    "January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sep\\.?|Sept\\.?|Oct\\.?|Nov\\.?|Dec\\.?"
  ;

  const patterns = [
    new RegExp(`\\b(?:${months})\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}\\b`, "gi"),
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g
  ];

  const dates = [];

  for (const pattern of patterns) {
    const matches = snippet.match(pattern) || [];
    for (const m of matches) {
      const iso = parseDateToIso(m);
      if (iso) dates.push({ raw: m, iso });
    }
  }

  return dates;
}

function scoreSnippetForPdufa(snippet) {
  const s = snippet.toLowerCase();
  let score = 0;

  if (s.includes("pdufa")) score += 50;
  if (s.includes("target action date")) score += 45;
  if (s.includes("action date")) score += 25;
  if (s.includes("prescription drug user fee act")) score += 45;
  if (s.includes("accepted") && (s.includes("nda") || s.includes("bla"))) score += 20;
  if (s.includes("priority review")) score += 10;
  if (s.includes("fda")) score += 10;
  if (s.includes("complete response letter")) score -= 15;

  return score;
}

function findBestPdufaCandidate(snippets) {
  const candidates = [];

  for (const snippet of snippets) {
    const lower = snippet.toLowerCase();

    const looksRelevant =
      lower.includes("pdufa") ||
      lower.includes("target action date") ||
      lower.includes("prescription drug user fee act") ||
      lower.includes("fda accepted") ||
      lower.includes("accepted the nda") ||
      lower.includes("accepted its nda") ||
      lower.includes("accepted the bla") ||
      lower.includes("accepted its bla");

    if (!looksRelevant) continue;

    const dates = extractDatesFromSnippet(snippet);
    const snippetScore = scoreSnippetForPdufa(snippet);

    for (const d of dates) {
      candidates.push({
        date: d.iso,
        rawDate: d.raw,
        score: snippetScore,
        snippet
      });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

async function findTickerInSec(ticker) {
  const data = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  const entries = Object.values(data);

  return entries.find(
    (x) => String(x.ticker || "").toUpperCase() === ticker.toUpperCase()
  );
}

function buildFilingUrl(cikNumber, accession, filename) {
  const cikNoZeros = String(Number(cikNumber));
  const accessionNoDash = accession.replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accessionNoDash}/${filename}`;
}

async function getDocumentUrlsForFiling(cikNumber, accession, primaryDocument) {
  const cikNoZeros = String(Number(cikNumber));
  const accessionNoDash = accession.replaceAll("-", "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accessionNoDash}`;

  const urls = new Set();

  if (primaryDocument) {
    urls.add(`${base}/${primaryDocument}`);
  }

  try {
    const index = await fetchJson(`${base}/index.json`);
    const items = index?.directory?.item || [];

    const htmlFiles = items
      .map((x) => x.name)
      .filter((name) => /\.(htm|html|txt)$/i.test(name));

    const exhibitFiles = htmlFiles.filter((name) =>
      /ex-?99|exhibit|press|news|release/i.test(name)
    );

    const selected =
      exhibitFiles.length > 0
        ? exhibitFiles.slice(0, 8)
        : htmlFiles.slice(0, 5);

    for (const name of selected) {
      urls.add(`${base}/${name}`);
    }
  } catch (_) {
    // If index.json fails, continue with primary document only.
  }

  return [...urls];
}

async function searchSecForPdufa(ticker) {
  const secCompany = await findTickerInSec(ticker);

  if (!secCompany) {
    return {
      found: false,
      reason: "Ticker not found in SEC company_tickers.json.",
      pdufa: null,
      sources: [],
      snippets: []
    };
  }

  const cik = padCik(secCompany.cik_str);
  const submissions = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`);

  const recent = submissions?.filings?.recent;

  if (!recent) {
    return {
      found: false,
      reason: "No recent SEC submissions found.",
      pdufa: null,
      sources: [],
      snippets: []
    };
  }

  const usefulForms = new Set([
    "8-K", "10-Q", "10-K", "6-K", "20-F", "40-F",
    "S-1", "S-1/A", "F-1", "F-1/A", "S-3", "S-3/A",
    "424B3", "424B4", "424B5", "424B7"
  ]);

  const filings = [];

  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const form = recent.form[i];

    if (!usefulForms.has(form)) continue;

    filings.push({
      form,
      accession: recent.accessionNumber[i],
      filingDate: recent.filingDate[i],
      primaryDocument: recent.primaryDocument[i],
      reportDate: recent.reportDate[i]
    });
  }

  const keywords = [
    "PDUFA",
    "target action date",
    "Prescription Drug User Fee Act",
    "FDA accepted",
    "accepted the NDA",
    "accepted its NDA",
    "accepted the BLA",
    "accepted its BLA",
    "NDA accepted",
    "BLA accepted",
    "priority review",
    "action date"
  ];

  const allSnippets = [];
  const sources = [];

  for (const filing of filings.slice(0, 40)) {
    const urls = await getDocumentUrlsForFiling(
      secCompany.cik_str,
      filing.accession,
      filing.primaryDocument
    );

    for (const url of urls) {
      try {
        const html = await fetchText(url);
        const text = stripHtml(html);

        const snippets = getSnippets(text, keywords);

        if (snippets.length) {
          sources.push({
            title: `${secCompany.title} ${filing.form}, filed ${filing.filingDate}`,
            url,
            source_type: "sec_filing",
            why_it_matters: "SEC filing or exhibit containing PDUFA/FDA catalyst language."
          });

          for (const snippet of snippets) {
            allSnippets.push({
              filing,
              url,
              snippet
            });
          }
        }
      } catch (_) {
        // Ignore individual document fetch failures.
      }
    }
  }

  const best = findBestPdufaCandidate(allSnippets.map((x) => x.snippet));

  if (!best) {
    return {
      found: false,
      reason: "No exact PDUFA date found in recent SEC filings/exhibits.",
      company: secCompany.title,
      cik,
      pdufa: null,
      sources,
      snippets: allSnippets.slice(0, 8)
    };
  }

  const matching = allSnippets.find((x) => x.snippet === best.snippet);

  return {
    found: true,
    company: secCompany.title,
    cik,
    pdufa: {
      date: best.date,
      rawDate: best.rawDate,
      snippet: best.snippet,
      sourceUrl: matching?.url || null,
      filing: matching?.filing || null,
      confidence: best.score >= 80 ? 90 : best.score >= 60 ? 80 : 65
    },
    sources,
    snippets: allSnippets.slice(0, 10)
  };
}

function buildResponse({ ticker, benchmark, secResult }) {
  const found = secResult.found;
  const p = secResult.pdufa;

  const regulatoryScore = found ? 7.5 : 3.5;
  const clinicalScore = found ? 5.5 : 4.5;
  const financialScore = 4.5;
  const valuationScore = 4.5;
  const commercialScore = 5.0;
  const managementScore = 5.0;
  const liquidityScore = 5.0;

  const overall =
    clinicalScore * 2.5 +
    regulatoryScore * 2.0 +
    financialScore * 1.75 +
    valuationScore * 1.75 +
    commercialScore * 1.0 +
    managementScore * 0.5 +
    liquidityScore * 0.5;

  return {
    ticker,
    company_name: secResult.company || "Unknown",
    benchmark_index: benchmark || "Unknown",
    overall_score_0_100: Math.round(overall),
    verdict: found
      ? "SEC filing/exhibit found with a candidate PDUFA or FDA action date. Verify the linked source manually before relying on it."
      : "No exact PDUFA date found in recent SEC filings/exhibits. This does not prove there is no PDUFA date; check company IR pages and FDA/company press releases.",
    confidence_0_100: found ? p.confidence : 45,
    pdufa: {
      date: found ? p.date : null,
      drug: null,
      indication: null,
      application_type: null,
      review_type: null,
      status: found
        ? "Candidate PDUFA/FDA action date found in SEC filing or exhibit."
        : secResult.reason,
      evidence_summary: found
        ? p.snippet
        : "No exact PDUFA date was found from recent SEC filings/exhibits using keyword search.",
      primary_source_title: found
        ? `${secResult.company} SEC filing/exhibit`
        : null,
      primary_source_url: found ? p.sourceUrl : null,
      source_quality: found ? "sec_filing" : "none",
      confidence_0_100: found ? p.confidence : 30
    },
    next_catalysts: found
      ? [
          {
            catalyst: "FDA PDUFA / target action date",
            expected_timing: p.date,
            importance: "High",
            risk: "Binary regulatory event; verify label, CRL risk, advisory committee risk, and CMC issues.",
            source_url: p.sourceUrl
          }
        ]
      : [],
    component_scores: {
      clinical_data_quality: clinicalScore,
      regulatory_path: regulatoryScore,
      financial_health_dilution: financialScore,
      valuation_risk_reward: valuationScore,
      commercial_potential: commercialScore,
      management_governance: managementScore,
      liquidity_technical_risk: liquidityScore
    },
    red_flags: [
      "This SEC-only version may miss PDUFA dates disclosed only on company IR pages, FDA documents, or paid biotech catalyst databases.",
      "Financial health and dilution are not fully analyzed in this version.",
      "Drug and indication extraction is not yet automated."
    ],
    positive_factors: found
      ? ["Candidate PDUFA/FDA action date found from SEC filing/exhibit, a primary source."]
      : [],
    explanation: found
      ? "The tool searched recent SEC filings and exhibits for PDUFA/FDA catalyst language and extracted the strongest date candidate from nearby text."
      : "The tool searched recent SEC filings and exhibits but did not find an exact PDUFA date. Add company press-release search in the next version.",
    missing_information: [
      "Company IR press release search",
      "FDA document/database verification",
      "ClinicalTrials.gov trial status",
      "Cash runway, dilution, and valuation calculations",
      "Manual verification of the linked SEC source"
    ],
    sources: secResult.sources || [],
    disclaimer: "Research only, not financial advice."
  };
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

    const body = req.body || {};
    const ticker = safeString(body.ticker, 40).toUpperCase();
    const benchmark = safeString(body.index || body.benchmark, 80);

    if (!ticker) {
      return res.status(400).json({
        error: "Please enter a ticker. SEC lookup works by ticker."
      });
    }

    const secResult = await searchSecForPdufa(ticker);
    const output = buildResponse({ ticker, benchmark, secResult });

    return res.status(200).json(output);
  } catch (error) {
    return res.status(500).json({
      ticker: null,
      company_name: "Unknown",
      benchmark_index: "Unknown",
      overall_score_0_100: 0,
      verdict: "Server error during SEC PDUFA search.",
      confidence_0_100: 0,
      pdufa: {
        date: null,
        drug: null,
        indication: null,
        application_type: null,
        review_type: null,
        status: "error",
        evidence_summary: error?.message || String(error),
        primary_source_title: null,
        primary_source_url: null,
        source_quality: "none",
        confidence_0_100: 0
      },
      next_catalysts: [],
      component_scores: {
        clinical_data_quality: 0,
        regulatory_path: 0,
        financial_health_dilution: 0,
        valuation_risk_reward: 0,
        commercial_potential: 0,
        management_governance: 0,
        liquidity_technical_risk: 0
      },
      red_flags: [error?.message || String(error)],
      positive_factors: [],
      explanation: "The server crashed while searching SEC EDGAR.",
      missing_information: [],
      sources: [],
      disclaimer: "Research only, not financial advice."
    });
  }
}
