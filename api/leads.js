function normalizeShopDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

async function getShopifyAccessToken(shop, clientId, clientSecret) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error('Shopify auth failed');
  return data.access_token;
}

async function createShopifyDiscount({ shop, token, code, name }) {
  const query = `
    mutation CreateGift10Discount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }
  `;

  const response = await fetch(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({
      query,
      variables: {
        basicCodeDiscount: {
          title: `Gift10 5% - ${name}`,
          code,
          startsAt: new Date().toISOString(),
          usageLimit: 1,
          appliesOncePerCustomer: true,
          context: { all: 'ALL' },
          customerGets: {
            appliesOnOneTimePurchase: true,
            appliesOnSubscription: false,
            items: { all: true },
            value: { percentage: 0.05 },
          },
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },
        },
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json();
  const result = data?.data?.discountCodeBasicCreate;
  if (!response.ok || data?.errors?.length || !result || result.userErrors?.length) {
    throw new Error(result?.userErrors?.[0]?.message || data?.errors?.[0]?.message || 'Discount creation failed');
  }
}

function buildCode(id) {
  return 'EKAANI5-' + id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false }); }
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ ok: false });

  let data;
  try { data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { return res.status(400).json({ ok: false }); }

  const { id, name, phone = '' } = data || {};
  if (
    typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) ||
    typeof name !== 'string' || !name.trim() || name.length > 30 ||
    typeof phone !== 'string' || (phone !== '' && !/^\d{10,15}$/.test(phone))
  ) return res.status(400).json({ ok: false });

  const sheetUrl = process.env.GOOGLE_SHEETS_WEB_APP_URL;
  const sheetSecret = process.env.GOOGLE_SHEETS_SECRET;
  if (!sheetUrl || !sheetSecret) return res.status(503).json({ ok: false });

  try {
    const sheetResponse = await fetch(sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: name.trim(), phone, secret: sheetSecret }),
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });

    const sheetResult = await sheetResponse.json();
    if (sheetResult?.error === 'duplicate_phone') {
      return res.status(409).json({ ok: false, error: 'duplicate_phone' });
    }
    if (!sheetResponse.ok || sheetResult.ok !== true) throw new Error('Sheet write failed');

    if (!phone) return res.status(200).json({ ok: true });

    const shop = normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN);
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!shop || !clientId || !clientSecret) {
      return res.status(503).json({ ok: false, error: 'shopify_not_configured' });
    }

    const code = buildCode(id);
    const token = await getShopifyAccessToken(shop, clientId, clientSecret);

    try {
      await createShopifyDiscount({ shop, token, code, name: name.trim() });
    } catch (error) {
      if (!/already exists|taken|code.*exist/i.test(String(error?.message || ''))) throw error;
    }

    return res.status(200).json({
      ok: true,
      discountCode: code,
      discountUrl: `https://www.ekaani.com/discount/${encodeURIComponent(code)}?redirect=%2F`,
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: 'server_error' });
  }
}
