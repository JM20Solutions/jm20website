// Cloudflare Worker — serves a pre-rendered static snapshot of the homepage to
// AI/search crawlers that can't (or don't reliably) execute JavaScript
// (GPTBot, ClaudeBot, PerplexityBot, etc.), while every real visitor gets the
// normal interactive React site, unchanged.
//
// Googlebot and Bingbot are intentionally NOT listed: they render JavaScript,
// so they index the real page. Serving them a different version risks being
// treated as cloaking.
//
// Also: any client that sends "Accept: text/markdown" (AI agents) gets a Markdown
// version of the homepage, taken from /llms.txt. Browsers never send that header.

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

function wantsMarkdown(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("Accept") || "";
  return /text\/markdown(?!\s*;\s*q=0(\.0*)?\s*(,|$))/i.test(accept);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only the homepage is ever swapped. Every other path is untouched.
    const isHomepage = url.pathname === "/" || url.pathname === "/index.html";
    if (!isHomepage) return env.ASSETS.fetch(request);

    // Agents asking for Markdown get /llms.txt as the homepage Markdown.
    if (wantsMarkdown(request)) {
      const source = await env.ASSETS.fetch(new URL("/llms.txt", url));
      if (source.ok) {
        const markdown = await source.text();
        return new Response(request.method === "HEAD" ? null : markdown, {
          status: 200,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Vary": "Accept, User-Agent",
            "Cache-Control": "public, max-age=0, must-revalidate",
            "Content-Signal": "ai-train=no, search=yes, ai-input=yes",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }
    }

    const userAgent = request.headers.get("User-Agent") || "";
    const target = isKnownBot(userAgent)
      ? new Request(new URL("/bot-snapshot", url), request)
      : request;

    const response = await env.ASSETS.fetch(target);

    // The homepage response depends on the User-Agent, so tell caches.
    const out = new Response(response.body, response);
    out.headers.append("Vary", "Accept, User-Agent");
    return out;
  }
};
