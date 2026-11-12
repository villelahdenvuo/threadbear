import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeDecode, withCard } from '../../../convex/shareCard.ts';

const page = '<html><head>\n    <title>Threadbear</title>\n  </head><body><div id="root"></div></body></html>';
const url = new URL('https://example.convex.site/s/abc');

test("a shared thread's page: its words go in the tags as they are, `$` patterns and all", () => {
  // String.replace reads these in a replacement string: `$'` was the rest of
  // the page, `$&` the old <title>, pasted into the tags.
  const description = "printf $'a\\nb' and $& and $` and $<x> and $$";
  const out = withCard(page, { title: 'Costs $& more', description }, url);
  assert.ok(out.includes(`<title>Costs $&amp; more · Threadbear</title>`));
  assert.ok(out.includes(`<meta property="og:description" content="printf $'a\\nb' and $&amp; and $\` and $&lt;x&gt; and $$" />`));
  assert.equal(out.match(/<body>/g)?.length, 1, 'no piece of the page is repeated');
  assert.ok(!out.includes('<title>Threadbear</title>'));
});

test('quotes and tags in the title are escaped', () => {
  const out = withCard(page, { title: '"><script>x</script>', description: '' }, url);
  assert.ok(out.includes('content="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'));
  assert.ok(!out.includes('<script>'));
});

test('a bad escape in a share link is no slug, not a thrown error', () => {
  assert.equal(safeDecode('%zz'), '');
  assert.equal(safeDecode('%E0'), '');
  assert.equal(safeDecode('a%20b'), 'a b');
});
