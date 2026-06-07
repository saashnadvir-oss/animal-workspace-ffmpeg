const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP = '/tmp/aw';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

function generateKlingJWT(accessKey, secretKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secretKey).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

async function downloadFile(url, dest) {
  let dlUrl = url;
  const driveMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) dlUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  const res = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 60000, maxRedirects: 5 });
  fs.writeFileSync(dest, Buffer.from(res.data));
}

function pngToVideo(inputPng, outputMp4, duration) {
  execSync(`ffmpeg -y -loop 1 -i "${inputPng}" -c:v libx264 -t ${duration} -pix_fmt yuv420p -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2" -r 30 "${outputMp4}"`);
}

function normalizeClip(inputMp4, outputMp4) {
  execSync(`ffmpeg -y -i "${inputMp4}" -c:v libx264 -pix_fmt yuv420p -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2" -r 30 -c:a aac -ar 44100 -ac 2 "${outputMp4}"`);
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'animal-workspace-ffmpeg' }));

// Generate Kling image — called by n8n instead of calling Kling directly
app.post('/kling/image', async (req, res) => {
  try {
    const { access_key, secret_key, prompt } = req.body;
    if (!access_key || !secret_key || !prompt) {
      return res.status(400).json({ error: 'access_key, secret_key, and prompt are required' });
    }
    const token = generateKlingJWT(access_key, secret_key);
    const response = await axios.post('https://api.klingai.com/v1/images/generations', {
      model: 'kling-v1',
      prompt: prompt,
      n: 1,
      aspect_ratio: '9:16'
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    console.log('Kling image response:', JSON.stringify(response.data));
    res.json({ ...response.data, jwt_token: token });
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('Kling image error:', JSON.stringify(errData));
    res.status(err.response?.status || 500).json({ error: errData });
  }
});

// Get image task status
app.post('/kling/image/status', async (req, res) => {
  try {
    const { access_key, secret_key, task_id } = req.body;
    const token = generateKlingJWT(access_key, secret_key);
    const response = await axios.get(`https://api.klingai.com/v1/images/generations/${task_id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 30000
    });
    console.log('Kling image status:', JSON.stringify(response.data));
    res.json(response.data);
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('Kling image status error:', JSON.stringify(errData));
    res.status(err.response?.status || 500).json({ error: errData });
  }
});

// Generate all 4 video shots — called by n8n with all shot prompts at once
app.post('/kling/videos', async (req, res) => {
  try {
    const { access_key, secret_key, character_image_url, shots } = req.body;
    if (!access_key || !secret_key || !character_image_url || !shots) {
      return res.status(400).json({ error: 'access_key, secret_key, character_image_url, and shots are required' });
    }
    const token = generateKlingJWT(access_key, secret_key);
    const taskIds = [];
    for (const shot of shots) {
      const response = await axios.post('https://api.klingai.com/v1/videos/image2video', {
        model_name: 'kling-v1',
        prompt: shot.prompt,
        image_url: character_image_url,
        duration: '10',
        aspect_ratio: '9:16',
        mode: 'pro'
      }, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      console.log(`Shot ${shot.shot_number} response:`, JSON.stringify(response.data));
      if (!response.data.data?.task_id) {
        throw new Error(`Shot ${shot.shot_number} failed: ${JSON.stringify(response.data)}`);
      }
      taskIds.push({ shot_number: shot.shot_number, task_id: response.data.data.task_id });
      await new Promise(r => setTimeout(r, 3000));
    }
    res.json({ task_ids: taskIds });
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('Kling videos error:', JSON.stringify(errData));
    res.status(err.response?.status || 500).json({ error: errData });
  }
});

// Check video task statuses
app.post('/kling/videos/status', async (req, res) => {
  try {
    const { access_key, secret_key, task_ids } = req.body;
    const token = generateKlingJWT(access_key, secret_key);
    const results = [];
    for (const task of task_ids) {
      const response = await axios.get(`https://api.klingai.com/v1/videos/image2video/${task.task_id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 30000
      });
      const status = response.data.data?.task_status;
      const videoUrl = response.data.data?.task_result?.videos?.[0]?.url;
      results.push({ shot_number: task.shot_number, task_id: task.task_id, status, video_url: videoUrl || null });
      await new Promise(r => setTimeout(r, 500));
    }
    const allDone = results.every(r => r.status === 'succeed');
    const anyFailed = results.some(r => r.status === 'failed');
    res.json({ results, all_ready: allDone, any_failed: anyFailed });
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('Kling status error:', JSON.stringify(errData));
    res.status(err.response?.status || 500).json({ error: errData });
  }
});

// Stitch video
app.post('/stitch', async (req, res) => {
  const jobId = Date.now().toString();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    const { intro_url, outro_url, clip_urls, title } = req.body;
    if (!intro_url || !outro_url || !clip_urls || clip_urls.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    console.log(`[${jobId}] Stitching: ${title}`);
    const introPng = path.join(jobDir, 'intro.png');
    await downloadFile(intro_url, introPng);
    const outroPng = path.join(jobDir, 'outro.png');
    await downloadFile(outro_url, outroPng);
    const introMp4 = path.join(jobDir, 'intro.mp4');
    pngToVideo(introPng, introMp4, 2);
    const outroMp4 = path.join(jobDir, 'outro.mp4');
    pngToVideo(outroPng, outroMp4, 3);
    const normalizedClips = [];
    for (let i = 0; i < clip_urls.length; i++) {
      const rawClip = path.join(jobDir, `raw_${i}.mp4`);
      await downloadFile(clip_urls[i], rawClip);
      const normClip = path.join(jobDir, `clip_${i}.mp4`);
      normalizeClip(rawClip, normClip);
      normalizedClips.push(normClip);
    }
    const concatList = path.join(jobDir, 'concat.txt');
    const allClips = [introMp4, ...normalizedClips, outroMp4];
    fs.writeFileSync(concatList, allClips.map(f => `file '${f}'`).join('\n'));
    const finalMp4 = path.join(jobDir, 'final.mp4');
    execSync(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -c:a aac -pix_fmt yuv420p -movflags +faststart "${finalMp4}"`);
    const stat = fs.statSync(finalMp4);
    console.log(`[${jobId}] Done. Size: ${(stat.size/1024/1024).toFixed(2)}MB`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${jobId}.mp4"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(finalMp4);
    stream.pipe(res);
    stream.on('end', () => fs.rmSync(jobDir, { recursive: true, force: true }));
  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    fs.rmSync(jobDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
