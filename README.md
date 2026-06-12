# AI Biotech Stock Analyzer - Vercel + OpenAI

This is a minimal deployable Vercel starter.

## What it does

- User enters ticker/company/index.
- Frontend calls `/api/analyze`.
- Serverless backend calls OpenAI Responses API with web search.
- Model tries to find PDUFA date, catalysts, red flags, and sources.
- Returns a structured biotech research score.

## Important limitation

This is a research assistant, not a financial advisor. PDUFA dates and biotech catalysts must be verified from primary sources:
FDA, SEC EDGAR, ClinicalTrials.gov, company press releases, and trusted news/data providers.

## Local setup

```bash
npm install
npm i -g vercel
vercel dev
```

Create a `.env.local` file:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5.5
```

Then open:

```text
http://localhost:3000
```

## Deploy on Vercel

1. Push this folder to GitHub.
2. Import the repo in Vercel.
3. Add Environment Variable:
   - `OPENAI_API_KEY`
   - optional: `OPENAI_MODEL`
4. Deploy.

## Why the API key is server-side

Never expose your OpenAI API key in frontend HTML or JavaScript. The browser should only call your serverless API route.