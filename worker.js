// Cloudflare Worker — serves a pre-rendered static snapshot of the homepage to
// AI/search crawlers that can't (or don't reliably) execute JavaScript
// (GPTBot, ClaudeBot, PerplexityBot, etc.), while every real visitor gets the
// normal interactive React site, unchanged.
//
// Googlebot and Bingbot are intentionally NOT listed: they render JavaScript,
// so they index the real page. Serving them a different version risks being
// treated as cloaking.

const BOT_PATTERNS = [
  /duckduckbot/i,
  /gptbot/i,
  /chatgpt-user/i,
  /oai-searchbot/i,
  /claudebot/i,
  /claude-user/i,
  /claude-searchbot/i,
  /anthropic-ai/i,
  /perplexitybot/i,
  /perplexity-user/i,
  /ccbot/i,
  /applebot/i,
  /bytespider/i,
  /facebookexternalhit/i,
  /meta-externalagent/i
];

function isKnownBot(userAgent) {
  if (!userAgent) return false;
  return BOT_PATTERNS.some(pattern => pattern.test(userAgent));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only the homepage is ever swapped. Every other path is untouched.
    const isHomepage = url.pathname === "/" || url.pathname === "/index.html";
    if (!isHomepage) return env.ASSETS.fetch(request);

    const userAgent = request.headers.get("User-Agent") || "";
    const target = isKnownBot(userAgent)
      ? new Request(new URL("/bot-snapshot", url), request)
      : request;

    const response = await env.ASSETS.fetch(target);

    // The homepage response depends on the User-Agent, so tell caches.
    const out = new Response(response.body, response);
    out.headers.append("Vary", "User-Agent");
    return out;
  }
};
