export default async function handler(req, res) {
  res.status(200).json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
    timestamp: new Date().toISOString()
  });
}
