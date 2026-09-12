const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
const path = require('path');
const sharp = require('sharp');
require('dotenv').config();

const PUBLIC_KEY = process.env.ILOVEIMG_PUBLIC_KEY;
const SECRET_KEY = process.env.ILOVEIMG_SECRET_KEY;
const REMOVE_BG_TOOL = 'removebackgroundimage';

function getAuthToken() {
  if (!PUBLIC_KEY || !SECRET_KEY) {
    throw new Error('Missing ILOVEIMG_PUBLIC_KEY or ILOVEIMG_SECRET_KEY in .env');
  }
  const timeNow = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { jti: PUBLIC_KEY, iss: 'api.ilovepdf.com', iat: timeNow - 5 },
    SECRET_KEY
  );
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route to handle Background Removal via iLoveAPI
app.post('/api/remove-bg', upload.single('image_file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    // 1. Normalize image format to PNG using Sharp to support WebP, AVIF, HEIC, TIFF, PNG, JPG, etc.
    let pngBuffer;
    try {
      pngBuffer = await sharp(req.file.buffer).png().toBuffer();
    } catch (conversionErr) {
      console.warn('Sharp conversion warning, using raw buffer:', conversionErr.message);
      pngBuffer = req.file.buffer;
    }

    const token = getAuthToken();

    // 2. Start remove-background task (GET /v1/start/{tool})
    const startTaskRes = await axios.get(
      `https://api.ilovepdf.com/v1/start/${REMOVE_BG_TOOL}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
    );
    const { server, task } = startTaskRes.data;

    // 3. Upload File
    const formData = new FormData();
    formData.append('task', task);
    formData.append('file', pngBuffer, {
      filename: 'input_image.png',
      contentType: 'image/png'
    });

    const uploadRes = await axios.post(`https://${server}/v1/upload`, formData, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...formData.getHeaders()
      },
      timeout: 60000
    });
    const serverFilename = uploadRes.data.server_filename;

    // 4. Process Background Removal
    await axios.post(`https://${server}/v1/process`, {
      task: task,
      tool: REMOVE_BG_TOOL,
      files: [{ server_filename: serverFilename, filename: 'input_image.png' }]
    }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000
    });

    // 5. Download Output PNG
    const downloadRes = await axios.get(`https://${server}/v1/download/${task}`, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: 60000
    });

    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(downloadRes.data));

  } catch (error) {
    const apiError = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    console.error('iLoveAPI Error Details:', error.response?.data || error.message);
    res.status(500).json({
      error: apiError || 'Background removal failed',
      details: error.response?.data || error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BG Tools Server running on http://localhost:${PORT}`);
});