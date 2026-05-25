const EU_COUNTRIES = [
  'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI',
  'FR','GR','HR','HU','IE','IT','LT','LU','LV','MT',
  'NL','PL','PT','RO','SE','SI','SK'
];

export default {
  async fetch(request, env, ctx) {
    const country = request.cf?.country;

    if (!country || !EU_COUNTRIES.includes(country)) {
      return new Response('Access not available in your region.', { status: 403 });
    }

    return env.ASSETS.fetch(request);
  }
};
