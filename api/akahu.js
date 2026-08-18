// Server-side proxy for the Akahu API.
// The browser can't call api.akahu.nz directly (Akahu doesn't allow
// cross-origin requests from arbitrary sites), so this function makes
// the request server-side, where CORS doesn't apply, and relays the
// result back to the client.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { appId, userToken } = req.body || {};
  if (!appId || !userToken) {
    return res.status(400).json({ error: 'Missing appId or userToken' });
  }

  const headers = {
    Authorization: `Bearer ${userToken}`,
    'X-Akahu-ID': appId,
  };

  try {
    const accountsRes = await fetch('https://api.akahu.io/v1/accounts', { headers });
    if (!accountsRes.ok) {
      const body = await accountsRes.text();
      return res.status(accountsRes.status).json({ error: `Failed to fetch accounts: ${accountsRes.status} ${body}` });
    }
    const accountsData = await accountsRes.json();
    const accounts = accountsData.items || [];

    if (accounts.length === 0) {
      return res.status(200).json({ transactions: [], message: 'No accounts found. Check your token and try again.' });
    }

    // Akahu returns 100 transactions per page — only ~4 weeks of spending,
    // which silently truncated the page's "Monthly" view. Follow the cursor,
    // bounded so a long history can't hang the request.
    const MAX_PAGES = 5;
    const transactions = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://api.akahu.io/v1/transactions');
      if (cursor) url.searchParams.set('cursor', cursor);

      const txRes = await fetch(url, { headers });
      if (!txRes.ok) {
        const body = await txRes.text();
        return res.status(txRes.status).json({ error: `Failed to fetch transactions: ${txRes.status} ${body}` });
      }
      const txData = await txRes.json();
      transactions.push(...(txData.items || []));

      cursor = txData.cursor?.next;
      if (!cursor) break;
    }

    return res.status(200).json({ transactions });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
