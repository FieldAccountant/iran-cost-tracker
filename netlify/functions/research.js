// Netlify serverless function
// - Holds API key securely (set as environment variable in Netlify dashboard)
// - Manages 6-hour shared cache so all visitors share one result
// - Proxies requests to Anthropic API

const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

// In-memory cache (persists between requests on the same function instance)
// For a more persistent cache across cold starts, upgrade to Netlify KV
let cache = {
  data: null,
  timestamp: null
};

const SYSTEM_PROMPT = `Nonpartisan defense analyst. Research U.S. military costs and casualties for Iran-linked operations Jan 1 2025–today. Use web search. For approprCost, search and sum ALL Congressional emergency defense appropriations bills passed since Jan 1 2025 related to Iran operations — include every supplemental package, continuing resolution add-on, and emergency authorization. Return ONLY valid JSON, no markdown:
{"totalCost":"$XB","totalRaw":number,"militaryCost":"$XB","militaryRaw":number,"aidCost":"$XB","aidRaw":number,"approprCost":"$XB","approprRaw":number,"totalCostNote":"string","militaryCostNote":"string","aidCostNote":"string","approprCostNote":"X bills totaling $XB, Jan 2025–present","casualties":{"kia":number,"wia":number,"kiaSub":"string","wiaSub":"string","note":"string","incidents":[{"date":"Mon YYYY","description":"string","toll":"string"}]},"breakdown":[{"category":"string","amount":"$XB","amountRaw":number,"description":"string"}],"news":[{"date":"Mon YYYY","headline":"string","amount":"string","source":"string"}],"analysis":"string","sources":["string"],"lastUpdated":"string"}`;

exports.handler = async (event) => {

  // CORS headers — allow your Netlify frontend to call this function
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Only allow GET and POST
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const forceRefresh = event.queryStringParameters?.refresh === "true";
  const now = Date.now();

  // Check cache — return immediately if fresh and not forced refresh
  if (!forceRefresh && cache.data && cache.timestamp && (now - cache.timestamp) < CACHE_DURATION_MS) {
    const ageMinutes = Math.round((now - cache.timestamp) / 60000);
    console.log(`Cache hit — age: ${ageMinutes} minutes`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...cache.data,
        _cached: true,
        _cacheAge: ageMinutes,
        _cacheExpires: Math.round((CACHE_DURATION_MS - (now - cache.timestamp)) / 60000)
      })
    };
  }

  // Cache miss or forced refresh — call Anthropic API
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY environment variable not set");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "API key not configured. Set ANTHROPIC_API_KEY in Netlify environment variables." })
    };
  }

  console.log("Cache miss — fetching fresh data from Anthropic...");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: "Search for U.S. military costs and service member casualties (KIA/WIA) from Iran-linked operations Jan 1 2025 to today. Include Operation Midnight Hammer, carrier deployments, Congressional appropriations, missile defense intercepts, and confirmed U.S. casualties. Return JSON only."
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      throw new Error(`Anthropic API ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();

    // Extract text from response blocks
    const rawText = data.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    // Strip any markdown fences and parse JSON
    const cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error("No JSON found in Anthropic response");
    }

    // Robust JSON cleaner — fixes common AI formatting issues
    let jsonStr = jsonMatch[0];
    // Remove trailing commas before ] or }
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
    // Remove any control characters
    jsonStr = jsonStr.replace(/[\x00-\x1F\x7F]/g, ' ');
    // Fix common escape issues
    jsonStr = jsonStr.replace(/\\'/g, "'");

    const parsed = JSON.parse(jsonStr);

    // Save to cache
    cache.data = parsed;
    cache.timestamp = now;
    console.log("Fresh data cached successfully");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...parsed,
        _cached: false,
        _cacheAge: 0,
        _cacheExpires: 360
      })
    };

  } catch (err) {
    console.error("Function error:", err.message);

    // If we have stale cache, return it rather than failing completely
    if (cache.data) {
      const ageMinutes = Math.round((now - cache.timestamp) / 60000);
      console.log(`Returning stale cache (${ageMinutes}min old) due to error`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...cache.data,
          _cached: true,
          _stale: true,
          _cacheAge: ageMinutes,
          _error: err.message
        })
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
