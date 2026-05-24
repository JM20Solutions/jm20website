const EU_COUNTRIES = [
  'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI',
  'FR','GR','HR','HU','IE','IT','LT','LU','LV','MT',
  'NL','PL','PT','RO','SE','SI','SK'
];

export default async (request, context) => {
  const country = context.geo?.country?.code;

  if (!country || !EU_COUNTRIES.includes(country)) {
    return new Response('Access not available in your region.', { status: 403 });
  }
};

export const config = { path: "/*" };
