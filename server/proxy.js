import express from 'express';
import fetch from 'node-fetch';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';

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

// Ensure upload directory exists
const UPLOAD_DIR = path.join(process.cwd(), 'server', 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { }

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, UPLOAD_DIR); },
  filename: function (req, file, cb) { const safe = Date.now() + '-' + (file.originalname || 'upload'); cb(null, safe); }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB limit

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

// Serve uploaded files
app.get('/uploads/:name', (req, res) => {
  const name = req.params.name;
  const p = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  return res.sendFile(p);
});

// Simple image upload endpoint: accepts multipart form field 'image'
app.post('/upload-image', upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (use field name "image")' });
    const url = `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(req.file.filename)}`;
    return res.json({ ok: true, filename: req.file.filename, path: req.file.path, url });
  } catch (err) {
    console.error('upload-image error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Depth estimation forwarding endpoint.
// If DEPTH_MODEL_URL is configured in env, the server forwards the uploaded image to that URL and returns the model response.
// Otherwise returns a 501 with guidance.
app.post('/depth', upload.single('image'), async (req, res) => {
  try {
    const modelUrl = process.env.DEPTH_MODEL_URL;
    const modelKey = process.env.DEPTH_MODEL_KEY || null; // optional
    let filePath = null;
    if (req.file) filePath = req.file.path;
    else if (req.body && req.body.filename) {
      const candidate = path.join(UPLOAD_DIR, req.body.filename);
      if (fs.existsSync(candidate)) filePath = candidate;
    }

    if (!filePath) return res.status(400).json({ error: 'No image provided. Upload as multipart field "image" or provide previously uploaded filename.' });

    if (!modelUrl) {
      return res.status(501).json({
        error: 'Depth model endpoint not configured. Set DEPTH_MODEL_URL environment variable to forward images to a depth/3D service.',
        note: 'You can still upload images to /upload-image and call /depth once DEPTH_MODEL_URL is set. Example providers: self-hosted MiDaS API, Replicate endpoints, or custom cloud model.'
      });
    }

    // Forward file to model URL as multipart/form-data
    const form = new FormData();
    form.append('image', fs.createReadStream(filePath));
    // include any extra fields if present
    for (const k of Object.keys(req.body || {})) {
      if (k === 'filename') continue;
      form.append(k, req.body[k]);
    }

    const headers = { ...form.getHeaders() };
    if (modelKey) headers['Authorization'] = `Bearer ${modelKey}`;

    const mfRes = await fetch(modelUrl, { method: 'POST', headers, body: form });
    const contentType = mfRes.headers.get('content-type') || '';
    // If model returned JSON, forward JSON; otherwise attempt to stream binary
    if (contentType.includes('application/json') || contentType.includes('json')) {
      const json = await mfRes.json();
      return res.json({ ok: true, modelResponse: json });
    } else {
      // pipe binary through
      const buf = await mfRes.arrayBuffer();
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      return res.send(Buffer.from(buf));
    }
  } catch (err) {
    console.error('depth forwarding error', err);
    return res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => { /* proxy started on port */ });
