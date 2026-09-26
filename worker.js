// Cloudflare Worker — serves a pre-rendered static snapshot to AI/search
// crawlers that can't execute JavaScript (GPTBot, ClaudeBot, PerplexityBot,
// etc.), while every real visitor continues to get the normal interactive
// React site, completely unchanged. No existing behavior is modified.

const BOT_PATTERNS = [
  /googlebot/i,
  /bingbot/i,
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userAgent = request.headers.get("User-Agent") || "";

    // Only intervene on the homepage. Every other path (images, assets,
    // any other page) is untouched, for bots and humans alike.
    const isHomepage = url.pathname === "/" || url.pathname === "/index.html";

    if (isHomepage && isKnownBot(userAgent)) {
      const snapshotUrl = new URL("/bot-snapshot.html", url);
      return env.ASSETS.fetch(new Request(snapshotUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};
