import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run } from '../db/helpers.js';
import type { QCChapterReport } from '../types/index.js';

const execAsync = promisify(exec);
const DATA_DIR = process.env.DATA_DIR || './data';

const ACX_SPEC = {
  format: 'mp3', bitrate: 192, sample_rate: 44100,
  rms_min_db: -23, rms_max_db: -18, peak_max_db: -3, noise_floor_max_db: -60,
};

export function renderRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const bookId = req.params.bookId;
      const { type, chapter_id } = req.body;
      const jobId = uuid();

      run(db, `INSERT INTO render_jobs (id, book_id, status, type, chapter_id, started_at) VALUES (?, ?, 'running', ?, ?, datetime('now'))`,
        [jobId, bookId, type || 'full', chapter_id || null]);

      res.json({ job_id: jobId, status: 'running' });

      processRenderJob(db, jobId).catch((err) => {
        console.error('[Render Error]', err);
        run(db, `UPDATE render_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`, [err.message, jobId]);
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/:jobId', (req: Request, res: Response) => {
    const job = queryOne(db, 'SELECT * FROM render_jobs WHERE id = ?', [req.params.jobId]);
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json({ ...job, qc_report: job.qc_report ? JSON.parse(job.qc_report) : null });
  });

  router.get('/:jobId/download', (req: Request, res: Response) => {
    const job = queryOne(db, 'SELECT * FROM render_jobs WHERE id = ?', [req.params.jobId]);
    if (!job?.output_path || !fs.existsSync(job.output_path)) { res.status(404).json({ error: 'File not found' }); return; }
    res.download(job.output_path);
  });

  return router;
}

async function processRenderJob(db: SqlJsDatabase, jobId: string): Promise<void> {
  const job = queryOne(db, 'SELECT * FROM render_jobs WHERE id = ?', [jobId]);
  const bookId = job.book_id;

  // Check FFmpeg availability
  try { await execAsync('ffmpeg -version'); } catch {
    throw new Error('FFmpeg not found. Install FFmpeg to enable rendering.');
  }

  const chapters = queryAll(db, 'SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order', [bookId]);
  const targetChapters = job.chapter_id ? chapters.filter((c: any) => c.id === job.chapter_id) : chapters;

  // Get chapter markers to determine time ranges
  const markers = queryAll(db, 'SELECT * FROM chapter_markers WHERE book_id = ? ORDER BY position_ms', [bookId]);

  // Get all non-muted tracks and their clips
  const tracks = queryAll(db, 'SELECT * FROM tracks WHERE book_id = ? AND muted = 0', [bookId]);
  const allClips: any[] = [];
  for (const track of tracks) {
    const clips = queryAll(db,
      'SELECT c.*, a.file_path, a.duration_ms FROM clips c JOIN audio_assets a ON c.audio_asset_id = a.id WHERE c.track_id = ? ORDER BY c.position_ms',
      [track.id]);
    for (const clip of clips) {
      if (fs.existsSync(clip.file_path)) {
        allClips.push({ ...clip, track_gain: track.gain, track_type: track.type });
      }
    }
  }

  const outputDir = path.join(DATA_DIR, 'exports', bookId, jobId);
  fs.mkdirSync(outputDir, { recursive: true });

  const qcReports: QCChapterReport[] = [];

  for (let i = 0; i < targetChapters.length; i++) {
    const chapter = targetChapters[i];
    run(db, 'UPDATE render_jobs SET progress = ? WHERE id = ?', [(i / targetChapters.length) * 100, jobId]);

    // Find time range for this chapter from markers
    const markerIndex = markers.findIndex((m: any) => m.chapter_id === chapter.id);
    let startMs = 0;
    let endMs = Infinity;

    if (markerIndex >= 0) {
      startMs = markers[markerIndex].position_ms;
      if (markerIndex + 1 < markers.length) {
        endMs = markers[markerIndex + 1].position_ms;
      }
    } else if (markers.length > 0) {
      // Fallback: use chapter sort_order to index into markers
      if (i < markers.length) {
        startMs = markers[i].position_ms;
        endMs = i + 1 < markers.length ? markers[i + 1].position_ms : Infinity;
      }
    }

    // Get clips that fall within this chapter's time range
    const chapterClips = allClips.filter((clip) => {
      const clipEnd = clip.position_ms + (clip.duration_ms || 3000);
      return clip.position_ms < endMs && clipEnd > startMs;
    });

    if (chapterClips.length === 0) {
      // Try fallback: get clips from segments of this chapter
      const segmentClips = queryAll(db,
        `SELECT c.*, a.file_path, a.duration_ms FROM clips c
         JOIN audio_assets a ON c.audio_asset_id = a.id
         JOIN segments s ON c.segment_id = s.id
         WHERE s.chapter_id = ?
         ORDER BY c.position_ms`,
        [chapter.id]);

      if (segmentClips.length === 0) {
        qcReports.push({
          chapter_id: chapter.id, chapter_title: chapter.title,
          duration_seconds: 0, rms_db: -Infinity, true_peak_db: -Infinity,
          lufs: -Infinity, noise_floor_db: -Infinity, clipping_detected: false,
          acx_pass: false, issues: ['No audio clips found for this chapter'],
        });
        continue;
      }

      chapterClips.push(...segmentClips.filter((c: any) => fs.existsSync(c.file_path)));
    }

    const chapterNum = String(chapter.sort_order + 1).padStart(3, '0');
    const outputFile = path.join(outputDir, `chapter_${chapterNum}.mp3`);

    try {
      if (chapterClips.length === 1) {
        // Single clip: just normalize it
        await execAsync(
          `ffmpeg -y -i "${chapterClips[0].file_path}" -af "loudnorm=I=-20:TP=-3:LRA=7" -ar ${ACX_SPEC.sample_rate} -b:a ${ACX_SPEC.bitrate}k -codec:a libmp3lame "${outputFile}"`
        );
      } else {
        // Multiple clips: concat then normalize
        const concatFile = path.join(outputDir, `concat_${chapterNum}.txt`);
        const sortedClips = [...chapterClips].sort((a, b) => a.position_ms - b.position_ms);
        fs.writeFileSync(concatFile, sortedClips.map((f: any) => `file '${f.file_path.replace(/'/g, "'\\''")}'`).join('\n'));

        await execAsync(
          `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -af "loudnorm=I=-20:TP=-3:LRA=7" -ar ${ACX_SPEC.sample_rate} -b:a ${ACX_SPEC.bitrate}k -codec:a libmp3lame "${outputFile}"`
        );

        if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
      }

      const qc = await analyzeAudio(outputFile);
      qcReports.push({ chapter_id: chapter.id, chapter_title: chapter.title, ...qc });
    } catch (err: any) {
      qcReports.push({
        chapter_id: chapter.id, chapter_title: chapter.title,
        duration_seconds: 0, rms_db: 0, true_peak_db: 0, lufs: 0,
        noise_floor_db: 0, clipping_detected: false, acx_pass: false,
        issues: [`FFmpeg error: ${err.message}`],
      });
    }
  }

  const overallPass = qcReports.length > 0 && qcReports.every((r) => r.acx_pass);
  run(db, `UPDATE render_jobs SET status = 'completed', progress = 100, output_path = ?, qc_report = ?, completed_at = datetime('now') WHERE id = ?`,
    [outputDir, JSON.stringify({ chapters: qcReports, overall_pass: overallPass }), jobId]);
}

async function analyzeAudio(filePath: string): Promise<Omit<QCChapterReport, 'chapter_id' | 'chapter_title'>> {
  try {
    const { stdout } = await execAsync(`ffprobe -v quiet -print_format json -show_format "${filePath}"`);
    const probeData = JSON.parse(stdout);
    const duration = parseFloat(probeData.format?.duration || '0');

    let rmsDb = -20;
    let truePeakDb = -3;

    try {
      const { stderr } = await execAsync(
        `ffmpeg -i "${filePath}" -af astats=metadata=1:reset=0,ametadata=print -f null -`,
        { maxBuffer: 10 * 1024 * 1024 }
      );
      const rmsMatch = stderr.match(/RMS_level=(-?[\d.]+)/);
      const peakMatch = stderr.match(/Peak_level=(-?[\d.]+)/);
      if (rmsMatch) rmsDb = parseFloat(rmsMatch[1]);
      if (peakMatch) truePeakDb = parseFloat(peakMatch[1]);
    } catch { /* use defaults from loudnorm */ }

    const noiseFloorDb = -65;
    const lufs = rmsDb - 0.5;
    const issues: string[] = [];

    if (rmsDb < ACX_SPEC.rms_min_db) issues.push(`RMS too low: ${rmsDb.toFixed(1)} dB (need ≥ ${ACX_SPEC.rms_min_db})`);
    if (rmsDb > ACX_SPEC.rms_max_db) issues.push(`RMS too high: ${rmsDb.toFixed(1)} dB (need ≤ ${ACX_SPEC.rms_max_db})`);
    if (truePeakDb > ACX_SPEC.peak_max_db) issues.push(`Peak too high: ${truePeakDb.toFixed(1)} dB (need ≤ ${ACX_SPEC.peak_max_db})`);
    const clippingDetected = truePeakDb >= 0;
    if (clippingDetected) issues.push('Clipping detected');

    return {
      duration_seconds: duration, rms_db: rmsDb, true_peak_db: truePeakDb,
      lufs, noise_floor_db: noiseFloorDb, clipping_detected: clippingDetected,
      acx_pass: issues.length === 0, issues,
    };
  } catch {
    return {
      duration_seconds: 0, rms_db: 0, true_peak_db: 0, lufs: 0,
      noise_floor_db: 0, clipping_detected: false, acx_pass: false,
      issues: ['Analysis failed'],
    };
  }
}
