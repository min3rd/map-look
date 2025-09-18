import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Allow all origins so browser can call this proxy from your dev server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const OPENTOPO_HOST = 'https://api.opentopodata.org/v1';

app.all('/opentopo', async (req, res) => {
  try {
    if (req.method === 'GET') {
      // Forward query params; allow dataset override via ?dataset=NAME
      const params = new URLSearchParams(req.query);
      const dataset = req.query.dataset || 'srtm90m';
      const url = `${OPENTOPO_HOST}/${encodeURIComponent(dataset)}?${params.toString()}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.json(data);
    }

    // For POST: accept JSON or form-encoded with 'locations' and 'interpolation'
  // For POST: accept JSON or form-encoded with 'locations', 'interpolation', 'format', etc.
  const body = new URLSearchParams();
  if (req.body.locations) body.append('locations', req.body.locations);
  else if (req.body.locationsArr && Array.isArray(req.body.locationsArr)) body.append('locations', req.body.locationsArr.join('|'));
  if (req.body.interpolation) body.append('interpolation', req.body.interpolation);
  if (req.body.format) body.append('format', req.body.format);
  const dataset = (req.body.dataset || req.query.dataset || 'srtm90m');

    const r = await fetch(`${OPENTOPO_HOST}/${encodeURIComponent(dataset)}`, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = await r.json();
    return res.json(data);
  } catch (err) {
    console.error('Proxy error', err);
    return res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => { /* proxy started on port */ });
