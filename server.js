const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP = '/tmp/aw';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

async function downloadFile(url, dest) {
  let dlUrl = url;
  const driveMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) {
    dlUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  }
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

app.post('/stitch', async (req, res) => {
  const jobId = Date.now().toString();
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { intro_url, outro_url, clip_urls, title } = req.body;
    if (!intro_url || !outro_url || !clip_urls || clip_urls.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: intro_url, outro_url, clip_urls' });
    }

    console.log(`[${jobId}] Starting stitch job: ${title}`);
    console.log(`[${jobId}] Downloading intro...`);
    const introPng = path.join(jobDir, 'intro.png');
    await downloadFile(intro_url, introPng);

    console.log(`[${jobId}] Downloading outro...`);
    const outroPng = path.join(jobDir, 'outro.png');
    await downloadFile(outro_url, outroPng);

    console.log(`[${jobId}] Converting intro PNG to video...`);
    const introMp4 = path.join(jobDir, 'intro.mp4');
    pngToVideo(introPng, introMp4, 2);

    console.log(`[${jobId}] Converting outro PNG to video...`);
    const outroMp4 = path.join(jobDir, 'outro.mp4');
    pngToVideo(outroPng, outroMp4, 3);

    const normalizedClips = [];
    for (let i = 0; i < clip_urls.length; i++) {
      console.log(`[${jobId}] Downloading clip ${i + 1}/${clip_urls.length}...`);
      const rawClip = path.join(jobDir, `raw_clip_${i}.mp4`);
      await downloadFile(clip_urls[i], rawClip);

      console.log(`[${jobId}] Normalizing clip ${i + 1}...`);
      const normClip = path.join(jobDir, `clip_${i}.mp4`);
      normalizeClip(rawClip, normClip);
      normalizedClips.push(normClip);
    }

    console.log(`[${jobId}] Creating concat list...`);
    const concatList = path.join(jobDir, 'concat.txt');
    const allClips = [introMp4, ...normalizedClips, outroMp4];
    const concatContent = allClips.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatList, concatContent);

    console.log(`[${jobId}] Stitching final video...`);
    const finalMp4 = path.join(jobDir, 'final.mp4');
    execSync(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -c:a aac -pix_fmt yuv420p -movflags +faststart "${finalMp4}"`);

    console.log(`[${jobId}] Sending final video...`);
    const stat = fs.statSync(finalMp4);
    console.log(`[${jobId}] Final video size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${jobId}_final.mp4"`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(finalMp4);
    stream.pipe(res);
    stream.on('end', () => {
      console.log(`[${jobId}] Done. Cleaning up...`);
      fs.rmSync(jobDir, { recursive: true, force: true });
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    fs.rmSync(jobDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Animal Workspace FFmpeg server running on port ${PORT}`));
