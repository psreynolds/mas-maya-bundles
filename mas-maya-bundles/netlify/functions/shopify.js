exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { store, action, bundleType } = body;

  const STORES = {
    com: '471f39',
    uk:  'uk-masmaya',
  };

  const BUNDLE_PREFIXES = {
    coating: 'MMCPlaq',
    lime:    'MMLWSamp',
  };

  const BUNDLE_NAMES = {
    coating: 'INTERNAL — Coating Samples Bundle',
    lime:    'INTERNAL — Lime Wash Samples Bundle',
  };

  const handle = STORES[store];
  if (!handle) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown store' }) };

  const domain = `${handle}.myshopify.com`;

  // Step 1 — get access token
  let token;
  try {
    const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Token fetch failed: ${t}` }) };
    }
    const tokenData = await tokenRes.json();
    token = tokenData.access_token;
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Token error: ${err.message}` }) };
  }

  const prefix = BUNDLE_PREFIXES[bundleType];
  if (!prefix) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown bundle type' }) };

  // Step 2 — fetch all variants matching prefix (deduplicated)
  let variants = [];
  let seenSkus = new Set();
  let pageInfo = null;
  let isFirst = true;

  try {
    while (isFirst || pageInfo) {
      isFirst = false;
      let path = `/products.json?limit=250&status=active&fields=id,status,variants`;
      if (pageInfo) path += `&page_info=${pageInfo}`;

      const r = await fetch(`https://${domain}/admin/api/2024-01${path}`, {
        headers: { 'X-Shopify-Access-Token': token },
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const data = await r.json();

      for (const product of data.products) {
        for (const variant of product.variants) {
          if (variant.sku && variant.sku.startsWith(prefix) && !seenSkus.has(variant.sku)) {
            seenSkus.add(variant.sku);
            variants.push(variant.id);
          }
        }
      }

      const lh = r.headers.get('link') || '';
      const nm = lh.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      pageInfo = nm ? nm[1] : null;
    }
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Product fetch failed: ${err.message}` }) };
  }

  if (variants.length === 0) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `No SKUs found starting with ${prefix}` }) };
  }

  // Step 3 — create draft order
  const lineItems = variants.map(id => ({
    variant_id: id,
    quantity: 1,

  }));

  try {
    const r = await fetch(`https://${domain}/admin/api/2024-01/draft_orders.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft_order: {
          line_items: lineItems,
          note: BUNDLE_NAMES[bundleType],
          tags: 'samples-bundle,internal',
        },
      }),
    });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const result = await r.json();
    const draft = result.draft_order;
    const adminUrl = `https://admin.shopify.com/store/${handle}/draft_orders/${draft.id}`;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, draftId: draft.id, draftName: draft.name, adminUrl }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Draft order failed: ${err.message}` }) };
  }
};
