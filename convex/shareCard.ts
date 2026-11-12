// A shared thread's page (/s/<slug>, http.ts): index.html with the thread's
// title and Open Graph and Twitter card tags. Plain functions, so the tests
// can run them without Convex.

export function withCard(html: string, card: { title: string; description: string; image?: string }, url: URL): string {
  const e = escapeHtml;
  const tags = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Threadbear" />`,
    `<meta property="og:title" content="${e(card.title)}" />`,
    `<meta property="og:url" content="${e(url.origin + url.pathname)}" />`,
    card.description ? `<meta property="og:description" content="${e(card.description)}" />` : '',
    card.description ? `<meta name="description" content="${e(card.description)}" />` : '',
    `<meta property="og:image" content="${e(card.image ?? `${url.origin}/icon.png`)}" />`,
    `<meta name="twitter:card" content="${card.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${e(card.title)}" />`,
    card.description ? `<meta name="twitter:description" content="${e(card.description)}" />` : '',
  ]
    .filter(Boolean)
    .join('\n    ');
  // A function, not a string: in a string `$'`, `$&` and the like in the
  // thread's own words would paste pieces of the page into the tags.
  const head = `<title>${e(card.title)} · Threadbear</title>\n    ${tags}`;
  return html.replace(/<title>[^<]*<\/title>/, () => head);
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
