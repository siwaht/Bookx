import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import JSZip from 'jszip';
import type { Database as SqlJsDatabase } from 'sql.js';
import { queryAll, queryOne, run, withTransaction } from '../db/helpers.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: MAX_FILE_SIZE },
});

// ── In-memory agent job runner ──
const activeJobs = new Map<string, { cancel: boolean }>();

interface AgentConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  accountId?: string;
  gatewayId?: string;
}

async function callLLM(config: AgentConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const { provider, model, apiKey, baseUrl, temperature = 0.7, maxTokens = 8192 } = config;

  let url = '';
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: any = {};

  if (provider === 'openai' || provider === 'openai-compatible') {
    url = baseUrl || 'https://api.openai.com/v1/chat/completions';
    const token = apiKey || process.env.OPENAI_API_KEY || '';
    if (!token && provider === 'openai') {
      throw new Error('OpenAI API key is required. Set it in the form or via OPENAI_API_KEY env variable.');
    }
    headers['Authorization'] = `Bearer ${token}`;
    body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
    };
  } else if (provider === 'gemini') {
    const token = apiKey || process.env.GEMINI_API_KEY || '';
    if (!token) {
      throw new Error('Gemini API key is required. Set it in the form or via GEMINI_API_KEY env variable.');
    }
    url = baseUrl || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${token}`;
    body = {
      contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    };
  } else if (provider === 'mistral') {
    url = baseUrl || 'https://api.mistral.ai/v1/chat/completions';
    const token = apiKey || process.env.MISTRAL_API_KEY || '';
    if (!token) {
      throw new Error('Mistral API key is required. Set it in the form or via MISTRAL_API_KEY env variable.');
    }
    headers['Authorization'] = `Bearer ${token}`;
    body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
    };
  } else if (provider === 'anthropic') {
    url = baseUrl || 'https://api.anthropic.com/v1/messages';
    const token = apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!token) {
      throw new Error('Anthropic API key is required. Set it in the form or via ANTHROPIC_API_KEY env variable.');
    }
    headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature,
      max_tokens: maxTokens,
    };
  } else if (provider === 'cloudflare') {
    // Cloudflare Workers AI — OpenAI-compatible endpoint
    const accountId = config.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '';
    const gatewayId = config.gatewayId || process.env.CLOUDFLARE_GATEWAY_ID || '';
    const token = apiKey || process.env.CLOUDFLARE_API_TOKEN || '';
    if (!token) {
      throw new Error('Cloudflare API token is required. Set it in the form or via CLOUDFLARE_API_TOKEN env variable.');
    }
    if (!accountId) {
      throw new Error('Cloudflare Account ID is required. Set it in the form or via CLOUDFLARE_ACCOUNT_ID env variable.');
    }
    if (gatewayId) {
      url = baseUrl || `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai/chat/completions`;
    } else {
      url = baseUrl || `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
    }
    headers['Authorization'] = `Bearer ${token}`;
    body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
    };
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`LLM API error (${res.status}): ${errText}`);
  }

  const data = await res.json();

  // Extract text based on provider response format
  if (provider === 'gemini') {
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else if (provider === 'anthropic') {
    return data.content?.[0]?.text || '';
  } else {
    // OpenAI-compatible: check content first, then reasoning_content for reasoning models (e.g. kimi-k2.5, deepseek-r1)
    const msg = data.choices?.[0]?.message;
    return msg?.content || msg?.reasoning_content || msg?.reasoning || '';
  }
}


// ── EPUB Parser (reused from import) ──
function stripHtml(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractEpubChapters(filePath: string): Promise<Array<{ title: string; text: string }>> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  let opfPath = 'content.opf';
  if (containerXml) {
    const m = containerXml.match(/full-path="([^"]+)"/);
    if (m) opfPath = m[1];
  }
  const opfContent = await zip.file(opfPath)?.async('string');
  if (!opfContent) {
    // fallback: extract all HTML
    const chapters: Array<{ title: string; text: string }> = [];
    const htmlFiles = Object.keys(zip.files)
      .filter(f => /\.(x?html?|xml)$/i.test(f) && !f.includes('META-INF'))
      .sort();
    for (const fp of htmlFiles) {
      const html = await zip.file(fp)!.async('string');
      const text = stripHtml(html).trim();
      if (text.length >= 10) chapters.push({ title: `Chapter ${chapters.length + 1}`, text });
    }
    return chapters;
  }

  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map<string, string>();
  let match;
  const r1 = /<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*>/gi;
  while ((match = r1.exec(opfContent)) !== null) manifest.set(match[1], match[2]);
  const r2 = /<item\s+[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*>/gi;
  while ((match = r2.exec(opfContent)) !== null) manifest.set(match[2], match[1]);

  const spineItems: string[] = [];
  const r3 = /<itemref\s+[^>]*idref="([^"]+)"[^>]*>/gi;
  while ((match = r3.exec(opfContent)) !== null) spineItems.push(match[1]);

  const chapters: Array<{ title: string; text: string }> = [];
  for (const itemId of spineItems) {
    const href = manifest.get(itemId);
    if (!href) continue;
    const fullPath = opfDir + decodeURIComponent(href);
    const file = zip.file(fullPath);
    if (!file) continue;
    const html = await file.async('string');
    const text = stripHtml(html).trim();
    if (text.length < 10) continue;
    const headingMatch = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i);
    const title = headingMatch?.[1]?.trim() || `Chapter ${chapters.length + 1}`;
    chapters.push({ title, text });
  }
  return chapters.length > 0 ? chapters : [];
}

async function extractPdfText(filePath: string): Promise<string> {
  // Simple PDF text extraction - reads raw stream and extracts text objects
  const buffer = fs.readFileSync(filePath);
  const content = buffer.toString('latin1');

  // Extract text between BT and ET markers (PDF text objects)
  const textParts: string[] = [];
  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let m;
  while ((m = btEtRegex.exec(content)) !== null) {
    const block = m[1];
    // Extract text from Tj, TJ, ' and " operators
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tm;
    while ((tm = tjRegex.exec(block)) !== null) {
      textParts.push(tm[1]);
    }
    // TJ array
    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
    while ((tm = tjArrayRegex.exec(block)) !== null) {
      const inner = tm[1];
      const strRegex = /\(([^)]*)\)/g;
      let sm;
      while ((sm = strRegex.exec(inner)) !== null) {
        textParts.push(sm[1]);
      }
    }
  }

  let text = textParts.join(' ')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function splitTextIntoChapters(text: string): Array<{ title: string; text: string }> {
  const patterns = [
    /^(Chapter\s+\d+[.:\s].*)$/gim,
    /^(CHAPTER\s+\d+[.:\s].*)$/gm,
    /^(Chapter\s+[IVXLCDM]+[.:\s].*)$/gim,
    /^(Part\s+\d+[.:\s].*)$/gim,
    /^(Chapter\s+\d+)$/gim,
  ];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length >= 2) {
      const chapters: Array<{ title: string; text: string }> = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index!;
        const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
        chapters.push({ title: matches[i][1].trim(), text: text.slice(start, end).trim() });
      }
      return chapters;
    }
  }
  // Fallback: chunk by ~5000 chars
  if (text.length > 8000) {
    const paragraphs = text.split(/\n\s*\n/);
    const chapters: Array<{ title: string; text: string }> = [];
    let current = '';
    let num = 1;
    for (const p of paragraphs) {
      if (current.length + p.length > 5000 && current.length > 0) {
        chapters.push({ title: `Section ${num}`, text: current.trim() });
        num++;
        current = '';
      }
      current += p + '\n\n';
    }
    if (current.trim()) chapters.push({ title: `Section ${num}`, text: current.trim() });
    return chapters;
  }
  return [{ title: 'Full Text', text: text.trim() }];
}


// ── Agent Processing Engine ──
async function processAgentJob(
  db: SqlJsDatabase,
  jobId: string,
  config: AgentConfig
): Promise<void> {
  const ctrl = activeJobs.get(jobId);

  function updateJob(fields: Record<string, any>) {
    const sets = Object.entries(fields).map(([k, _v]) => `${k} = ?`).join(', ');
    const vals = Object.values(fields);
    run(db, `UPDATE book_agent_jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`, [...vals, jobId]);
  }

  function addLog(taskId: string | null, level: string, message: string) {
    run(db, `INSERT INTO book_agent_logs (id, job_id, task_id, level, message) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), jobId, taskId, level, message]);
  }

  try {
    const job = queryOne(db, 'SELECT * FROM book_agent_jobs WHERE id = ?', [jobId]);
    if (!job) return;

    updateJob({ status: 'running', started_at: new Date().toISOString() });
    addLog(null, 'info', 'Agent job started');

    // Load the book content
    const chapters = queryAll(db, 'SELECT * FROM book_agent_chapters WHERE job_id = ? ORDER BY sort_order', [jobId]);
    if (chapters.length === 0) {
      updateJob({ status: 'failed', error_message: 'No chapters found in uploaded book' });
      addLog(null, 'error', 'No chapters found');
      return;
    }

    const totalChapters = chapters.length;
    const instructions = job.instructions;
    const bookTitle = job.original_filename || 'Untitled';

    // Load tasks
    const tasks = queryAll(db, 'SELECT * FROM book_agent_tasks WHERE job_id = ? ORDER BY sort_order', [jobId]);

    // ── PHASE 1: Pre-edit rating ──
    addLog(null, 'info', 'Phase 1: Rating original book...');
    updateJob({ progress: 5, current_phase: 'rating_original' });

    const fullText = chapters.map((c: any) => `## ${c.title}\n\n${c.original_text}`).join('\n\n---\n\n');
    const textPreview = fullText.length > 15000 ? fullText.slice(0, 15000) + '\n\n[...truncated for rating...]' : fullText;

    let preEditRating: any = null;
    try {
      const ratingPrompt = `You are a professional book editor and literary critic. Rate this book on world-class publishing standards.

Book Title: ${bookTitle}

Rate each category from 1-10 and provide brief justification:
1. Writing Quality (prose, grammar, style)
2. Story Structure (pacing, plot, arc)
3. Character Development
4. Dialogue Quality
5. World Building / Setting
6. Originality
7. Reader Engagement
8. Commercial Viability
9. Technical Accuracy (grammar, punctuation, consistency)
10. Overall Rating

Respond in valid JSON format:
{
  "ratings": {
    "writing_quality": { "score": 0, "comment": "" },
    "story_structure": { "score": 0, "comment": "" },
    "character_development": { "score": 0, "comment": "" },
    "dialogue_quality": { "score": 0, "comment": "" },
    "world_building": { "score": 0, "comment": "" },
    "originality": { "score": 0, "comment": "" },
    "reader_engagement": { "score": 0, "comment": "" },
    "commercial_viability": { "score": 0, "comment": "" },
    "technical_accuracy": { "score": 0, "comment": "" },
    "overall": { "score": 0, "comment": "" }
  },
  "summary": "Brief overall assessment",
  "strengths": ["strength1", "strength2"],
  "weaknesses": ["weakness1", "weakness2"]
}`;

      const ratingResult = await callLLM(config, ratingPrompt, textPreview);
      const jsonMatch = ratingResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        preEditRating = JSON.parse(jsonMatch[0]);
      }
    } catch (err: any) {
      addLog(null, 'warn', `Pre-edit rating failed: ${err.message}`);
    }

    if (preEditRating) {
      updateJob({ pre_edit_rating: JSON.stringify(preEditRating) });
      addLog(null, 'info', `Pre-edit overall rating: ${preEditRating.ratings?.overall?.score || 'N/A'}/10`);
    }

    if (ctrl?.cancel) { updateJob({ status: 'cancelled' }); return; }

    // ── PHASE 2: Process each chapter ──
    addLog(null, 'info', `Phase 2: Processing ${totalChapters} chapters...`);
    updateJob({ current_phase: 'editing' });

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    for (let i = 0; i < chapters.length; i++) {
      if (ctrl?.cancel) { updateJob({ status: 'cancelled' }); return; }

      const chapter = chapters[i] as any;
      const progress = 10 + Math.round((i / totalChapters) * 70);
      updateJob({ progress, current_chapter: i + 1, total_chapters: totalChapters });

      // Update or create task for this chapter
      let taskId = tasks.find((t: any) => t.chapter_index === i)?.id;
      if (!taskId) {
        taskId = uuid();
        run(db, `INSERT INTO book_agent_tasks (id, job_id, chapter_index, sort_order, title, status) VALUES (?, ?, ?, ?, ?, 'running')`,
          [taskId, jobId, i, i, `Edit: ${chapter.title}`]);
      } else {
        run(db, `UPDATE book_agent_tasks SET status = 'running', started_at = datetime('now') WHERE id = ?`, [taskId]);
      }

      addLog(taskId, 'info', `Processing chapter ${i + 1}/${totalChapters}: ${chapter.title}`);

      try {
        const editPrompt = `You are a world-class book editor. Your task is to improve this chapter based on the author's instructions.

INSTRUCTIONS FROM AUTHOR:
${instructions}

CHAPTER TITLE: ${chapter.title}
CHAPTER ${i + 1} OF ${totalChapters}

ORIGINAL TEXT:
${chapter.original_text}

Apply the author's instructions carefully. Return ONLY the improved/edited text of this chapter. Do not include any meta-commentary, explanations, or notes - just the edited chapter text itself. Preserve the author's voice and intent while making the requested improvements.`;

        const editedText = await callLLM(config, 'You are a professional book editor. Return only the edited text.', editPrompt);

        // Generate a diff summary
        const diffPrompt = `Compare these two versions of a chapter and provide a brief summary of changes made.

ORIGINAL (first 2000 chars):
${chapter.original_text.slice(0, 2000)}

EDITED (first 2000 chars):
${editedText.slice(0, 2000)}

Respond with a JSON object:
{
  "changes_summary": "Brief description of changes",
  "changes_count": 0,
  "change_types": ["grammar", "style", "structure", "content"]
}`;

        let changesSummary = '';
        try {
          const diffResult = await callLLM(config, 'Summarize the editing changes in JSON.', diffPrompt);
          const diffJson = diffResult.match(/\{[\s\S]*\}/);
          if (diffJson) {
            const parsed = JSON.parse(diffJson[0]);
            changesSummary = parsed.changes_summary || '';
          }
        } catch { changesSummary = 'Changes applied'; }

        // Save edited text
        run(db, `UPDATE book_agent_chapters SET edited_text = ?, changes_summary = ?, updated_at = datetime('now') WHERE id = ?`,
          [editedText, changesSummary, chapter.id]);

        run(db, `UPDATE book_agent_tasks SET status = 'completed', completed_at = datetime('now'), result_summary = ? WHERE id = ?`,
          [changesSummary, taskId]);

        addLog(taskId, 'info', `Chapter ${i + 1} completed: ${changesSummary}`);

        updateJob({ completed_chapters: i + 1 });
        consecutiveFailures = 0; // Reset on success
      } catch (err: any) {
        run(db, `UPDATE book_agent_tasks SET status = 'failed', error_message = ? WHERE id = ?`,
          [err.message, taskId]);
        addLog(taskId, 'error', `Chapter ${i + 1} failed: ${err.message}`);

        consecutiveFailures++;
        // Abort early if we hit repeated failures (likely a config/auth issue)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          const abortMsg = `Aborting: ${consecutiveFailures} consecutive chapters failed. This usually means the API key is invalid or missing. Last error: ${err.message}`;
          addLog(null, 'error', abortMsg);
          updateJob({ status: 'failed', error_message: abortMsg });
          return;
        }
      }
    }

    if (ctrl?.cancel) { updateJob({ status: 'cancelled' }); return; }

    // ── PHASE 3: Post-edit rating ──
    addLog(null, 'info', 'Phase 3: Rating edited book...');
    updateJob({ progress: 85, current_phase: 'rating_edited' });

    const editedChapters = queryAll(db, 'SELECT * FROM book_agent_chapters WHERE job_id = ? ORDER BY sort_order', [jobId]);
    const editedFullText = editedChapters
      .map((c: any) => `## ${c.title}\n\n${c.edited_text || c.original_text}`)
      .join('\n\n---\n\n');
    const editedPreview = editedFullText.length > 15000 ? editedFullText.slice(0, 15000) + '\n\n[...truncated...]' : editedFullText;

    let postEditRating: any = null;
    try {
      const ratingPrompt2 = `You are a professional book editor and literary critic. Rate this EDITED version of the book on world-class publishing standards.

Book Title: ${bookTitle}

Rate each category from 1-10 and provide brief justification:
1. Writing Quality  2. Story Structure  3. Character Development
4. Dialogue Quality  5. World Building  6. Originality
7. Reader Engagement  8. Commercial Viability  9. Technical Accuracy
10. Overall Rating

Respond in valid JSON:
{
  "ratings": {
    "writing_quality": { "score": 0, "comment": "" },
    "story_structure": { "score": 0, "comment": "" },
    "character_development": { "score": 0, "comment": "" },
    "dialogue_quality": { "score": 0, "comment": "" },
    "world_building": { "score": 0, "comment": "" },
    "originality": { "score": 0, "comment": "" },
    "reader_engagement": { "score": 0, "comment": "" },
    "commercial_viability": { "score": 0, "comment": "" },
    "technical_accuracy": { "score": 0, "comment": "" },
    "overall": { "score": 0, "comment": "" }
  },
  "summary": "",
  "improvements_from_original": ["improvement1"],
  "remaining_suggestions": ["suggestion1"]
}`;

      const ratingResult2 = await callLLM(config, ratingPrompt2, editedPreview);
      const jsonMatch2 = ratingResult2.match(/\{[\s\S]*\}/);
      if (jsonMatch2) postEditRating = JSON.parse(jsonMatch2[0]);
    } catch (err: any) {
      addLog(null, 'warn', `Post-edit rating failed: ${err.message}`);
    }

    if (postEditRating) {
      updateJob({ post_edit_rating: JSON.stringify(postEditRating) });
      addLog(null, 'info', `Post-edit overall rating: ${postEditRating.ratings?.overall?.score || 'N/A'}/10`);
    }

    // ── PHASE 4: Generate report ──
    addLog(null, 'info', 'Phase 4: Generating report...');
    updateJob({ progress: 90, current_phase: 'generating_report' });

    const completedTasks = queryAll(db, `SELECT * FROM book_agent_tasks WHERE job_id = ? AND status = 'completed'`, [jobId]);
    const failedTasks = queryAll(db, `SELECT * FROM book_agent_tasks WHERE job_id = ? AND status = 'failed'`, [jobId]);

    const report = {
      job_id: jobId,
      book_title: bookTitle,
      total_chapters: totalChapters,
      chapters_edited: completedTasks.length,
      chapters_failed: failedTasks.length,
      instructions,
      pre_edit_rating: preEditRating,
      post_edit_rating: postEditRating,
      chapter_summaries: editedChapters.map((c: any) => ({
        title: c.title,
        original_length: c.original_text?.length || 0,
        edited_length: c.edited_text?.length || 0,
        changes: c.changes_summary,
      })),
      completed_at: new Date().toISOString(),
    };

    updateJob({ report: JSON.stringify(report) });

    // ── PHASE 5: Build output file ──
    addLog(null, 'info', 'Phase 5: Building output file...');
    updateJob({ progress: 95, current_phase: 'building_output' });

    const outputFormat = job.output_format || job.original_format || 'epub';
    const outputDir = path.join(DATA_DIR, 'exports');
    fs.mkdirSync(outputDir, { recursive: true });

    let outputPath = '';
    if (outputFormat === 'epub') {
      outputPath = await buildEpub(editedChapters, bookTitle, job.author || '', outputDir, jobId);
    } else {
      // Default to text/markdown output
      outputPath = path.join(outputDir, `${jobId}_edited.txt`);
      const outputText = editedChapters
        .map((c: any) => `# ${c.title}\n\n${c.edited_text || c.original_text}`)
        .join('\n\n---\n\n');
      fs.writeFileSync(outputPath, outputText, 'utf-8');
    }

    updateJob({
      status: 'completed',
      progress: 100,
      current_phase: 'done',
      output_path: outputPath,
      completed_at: new Date().toISOString(),
    });

    addLog(null, 'info', `Job completed. Output: ${path.basename(outputPath)}`);
  } catch (err: any) {
    updateJob({ status: 'failed', error_message: err.message });
    addLog(null, 'error', `Job failed: ${err.message}`);
  } finally {
    activeJobs.delete(jobId);
  }
}

async function buildEpub(
  chapters: any[],
  title: string,
  author: string,
  outputDir: string,
  jobId: string
): Promise<string> {
  const zip = new JSZip();

  // mimetype (must be first, uncompressed)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // META-INF/container.xml
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // Build chapter XHTML files
  const manifestItems: string[] = [];
  const spineItems: string[] = [];

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const chId = `chapter${i + 1}`;
    const text = (ch.edited_text || ch.original_text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const paragraphs = text.split(/\n\n+/).map((p: string) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('\n');

    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${(ch.title || '').replace(/&/g, '&amp;')}</title></head>
<body>
<h1>${(ch.title || '').replace(/&/g, '&amp;')}</h1>
${paragraphs}
</body>
</html>`;

    zip.file(`OEBPS/${chId}.xhtml`, xhtml);
    manifestItems.push(`<item id="${chId}" href="${chId}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${chId}"/>`);
  }

  // content.opf
  const bookId = uuid();
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${title.replace(/&/g, '&amp;')}</dc:title>
    <dc:creator>${author.replace(/&/g, '&amp;')}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    ${spineItems.join('\n    ')}
  </spine>
</package>`);

  // nav.xhtml (table of contents)
  const tocItems = chapters.map((ch: any, i: number) =>
    `<li><a href="chapter${i + 1}.xhtml">${(ch.title || '').replace(/&/g, '&amp;')}</a></li>`
  ).join('\n      ');

  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title></head>
<body>
<nav epub:type="toc">
  <h1>Table of Contents</h1>
  <ol>
      ${tocItems}
  </ol>
</nav>
</body>
</html>`);

  const outputPath = path.join(outputDir, `${jobId}_edited.epub`);
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, content);
  return outputPath;
}


// ── Follow-up instruction processing ──
async function processFollowUp(
  db: SqlJsDatabase,
  jobId: string,
  followUpId: string,
  config: AgentConfig
): Promise<void> {
  const ctrl = activeJobs.get(followUpId);

  function addLog(level: string, message: string) {
    run(db, `INSERT INTO book_agent_logs (id, job_id, task_id, level, message) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), jobId, followUpId, level, message]);
  }

  try {
    const followUp = queryOne(db, 'SELECT * FROM book_agent_followups WHERE id = ?', [followUpId]);
    if (!followUp) return;

    run(db, `UPDATE book_agent_followups SET status = 'running', started_at = datetime('now') WHERE id = ?`, [followUpId]);
    addLog('info', `Follow-up started: ${followUp.instructions.slice(0, 100)}...`);

    const chapters = queryAll(db, 'SELECT * FROM book_agent_chapters WHERE job_id = ? ORDER BY sort_order', [jobId]);
    const totalChapters = chapters.length;

    for (let i = 0; i < chapters.length; i++) {
      if (ctrl?.cancel) {
        run(db, `UPDATE book_agent_followups SET status = 'cancelled' WHERE id = ?`, [followUpId]);
        return;
      }

      const chapter = chapters[i] as any;
      const currentText = chapter.edited_text || chapter.original_text;

      run(db, `UPDATE book_agent_followups SET progress = ?, current_chapter = ? WHERE id = ?`,
        [Math.round(((i + 1) / totalChapters) * 90), i + 1, followUpId]);

      try {
        const editPrompt = `You are a world-class book editor. Apply these ADDITIONAL instructions to the already-edited chapter.

FOLLOW-UP INSTRUCTIONS:
${followUp.instructions}

CHAPTER TITLE: ${chapter.title}
CHAPTER ${i + 1} OF ${totalChapters}

CURRENT TEXT:
${currentText}

Apply the instructions carefully. Return ONLY the updated text.`;

        const editedText = await callLLM(config, 'You are a professional book editor. Return only the edited text.', editPrompt);

        run(db, `UPDATE book_agent_chapters SET edited_text = ?, updated_at = datetime('now') WHERE id = ?`,
          [editedText, chapter.id]);

        addLog('info', `Chapter ${i + 1}/${totalChapters} updated`);
      } catch (err: any) {
        addLog('error', `Chapter ${i + 1} failed: ${err.message}`);
      }
    }

    // Optionally re-rate if requested
    if (followUp.re_rate) {
      addLog('info', 'Re-rating edited book...');
      run(db, `UPDATE book_agent_followups SET progress = 95 WHERE id = ?`, [followUpId]);

      const editedChapters = queryAll(db, 'SELECT * FROM book_agent_chapters WHERE job_id = ? ORDER BY sort_order', [jobId]);
      const editedText = editedChapters
        .map((c: any) => `## ${c.title}\n\n${c.edited_text || c.original_text}`)
        .join('\n\n---\n\n');
      const preview = editedText.length > 15000 ? editedText.slice(0, 15000) + '\n...' : editedText;

      try {
        const ratingPrompt = `Rate this book 1-10 on: writing_quality, story_structure, character_development, dialogue_quality, world_building, originality, reader_engagement, commercial_viability, technical_accuracy, overall. Respond in JSON with "ratings" object where each key has "score" and "comment".`;
        const result = await callLLM(config, ratingPrompt, preview);
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const rating = JSON.parse(jsonMatch[0]);
          run(db, `UPDATE book_agent_followups SET result_rating = ? WHERE id = ?`, [JSON.stringify(rating), followUpId]);
          // Also update the job's post-edit rating
          run(db, `UPDATE book_agent_jobs SET post_edit_rating = ?, updated_at = datetime('now') WHERE id = ?`,
            [JSON.stringify(rating), jobId]);
        }
      } catch (err: any) {
        addLog('warn', `Re-rating failed: ${err.message}`);
      }
    }

    // Rebuild output file
    addLog('info', 'Rebuilding output file...');
    const job = queryOne(db, 'SELECT * FROM book_agent_jobs WHERE id = ?', [jobId]);
    const editedChapters = queryAll(db, 'SELECT * FROM book_agent_chapters WHERE job_id = ? ORDER BY sort_order', [jobId]);
    const outputDir = path.join(DATA_DIR, 'exports');
    fs.mkdirSync(outputDir, { recursive: true });

    const outputFormat = job?.output_format || job?.original_format || 'epub';
    let outputPath = '';
    if (outputFormat === 'epub') {
      outputPath = await buildEpub(editedChapters, job?.original_filename || 'Untitled', job?.author || '', outputDir, `${jobId}_followup_${followUpId}`);
    } else {
      outputPath = path.join(outputDir, `${jobId}_followup_${followUpId}.txt`);
      const text = editedChapters.map((c: any) => `# ${c.title}\n\n${c.edited_text || c.original_text}`).join('\n\n---\n\n');
      fs.writeFileSync(outputPath, text, 'utf-8');
    }

    run(db, `UPDATE book_agent_followups SET status = 'completed', progress = 100, output_path = ?, completed_at = datetime('now') WHERE id = ?`,
      [outputPath, followUpId]);
    // Update main job output path too
    run(db, `UPDATE book_agent_jobs SET output_path = ?, updated_at = datetime('now') WHERE id = ?`, [outputPath, jobId]);

    addLog('info', 'Follow-up completed');
  } catch (err: any) {
    run(db, `UPDATE book_agent_followups SET status = 'failed', error_message = ? WHERE id = ?`, [err.message, followUpId]);
    addLog('error', `Follow-up failed: ${err.message}`);
  } finally {
    activeJobs.delete(followUpId);
  }
}

// ══════════════════════════════════════════
// ── Router ──
// ══════════════════════════════════════════

export function bookAgentRouter(db: SqlJsDatabase): Router {
  const router = Router({ mergeParams: true });

  // Helper to safely extract string param
  const param = (req: Request, name: string): string => {
    const v = req.params[name];
    return Array.isArray(v) ? v[0] : v;
  };

  // ── GET /prompt-guide ── Returns a prompt manual for users
  router.get('/prompt-guide', (_req: Request, res: Response) => {
    res.json({
      guide: {
        title: 'Book Editor Agent - Prompt Guide',
        description: 'Use these prompt templates to instruct the AI agent on how to edit your book.',
        templates: [
          {
            name: 'Grammar & Style Polish',
            prompt: 'Fix all grammar, punctuation, and spelling errors. Improve sentence flow and readability while preserving my voice and style. Remove redundant words and tighten prose.',
            category: 'editing',
          },
          {
            name: 'Deep Developmental Edit',
            prompt: 'Perform a developmental edit: improve pacing, strengthen character arcs, enhance dialogue, fix plot holes, and ensure consistent tone throughout. Add sensory details where the writing feels flat.',
            category: 'developmental',
          },
          {
            name: 'Dialogue Enhancement',
            prompt: 'Make all dialogue more natural and distinct per character. Each character should have a unique voice. Remove dialogue tags where action beats work better. Cut exposition dumps in dialogue.',
            category: 'dialogue',
          },
          {
            name: 'Show Don\'t Tell',
            prompt: 'Convert all "telling" passages to "showing" with vivid sensory details, action, and dialogue. Replace emotion labels with physical reactions and behaviors.',
            category: 'style',
          },
          {
            name: 'Pacing Improvement',
            prompt: 'Improve pacing throughout. Speed up slow sections by cutting unnecessary description. Slow down action scenes with more sensory detail. Ensure each chapter ends with a hook.',
            category: 'structure',
          },
          {
            name: 'Consistency Check',
            prompt: 'Check and fix all consistency issues: character names, physical descriptions, timeline, geography, plot details, and world-building rules. Flag any contradictions.',
            category: 'continuity',
          },
          {
            name: 'Genre-Specific Polish (Romance)',
            prompt: 'Enhance romantic tension, deepen emotional beats, strengthen the chemistry between leads. Ensure satisfying emotional payoffs. Polish intimate scenes for heat level consistency.',
            category: 'genre',
          },
          {
            name: 'Genre-Specific Polish (Thriller)',
            prompt: 'Increase tension and suspense. Tighten action sequences. Plant and pay off clues effectively. Ensure red herrings work. Make the antagonist more compelling. End chapters on cliffhangers.',
            category: 'genre',
          },
          {
            name: 'Line Edit Only',
            prompt: 'Perform a line-by-line edit focusing only on: word choice, sentence rhythm, eliminating clichés, varying sentence length, and improving clarity. Do not change plot, characters, or structure.',
            category: 'editing',
          },
          {
            name: 'Prepare for Publishing',
            prompt: 'Polish this manuscript to publishing-ready quality. Fix all errors, improve prose, ensure consistent formatting, check for sensitivity issues, and make it ready for submission to agents/publishers.',
            category: 'publishing',
          },
        ],
        tips: [
          'Be specific about what you want changed and what should stay the same.',
          'Mention your target audience and genre for better results.',
          'You can combine multiple instructions in one prompt.',
          'After the first pass, use follow-up instructions for targeted fixes.',
          'Ask for a re-rate after follow-ups to track improvement.',
        ],
      },
    });
  });

  // ── GET /jobs ── List all agent jobs
  router.get('/jobs', (_req: Request, res: Response) => {
    try {
      const jobs = queryAll(db, `SELECT id, original_filename, original_format, output_format, status, progress,
        current_phase, current_chapter, total_chapters, completed_chapters, instructions,
        pre_edit_rating, post_edit_rating, error_message, created_at, updated_at, started_at, completed_at
        FROM book_agent_jobs ORDER BY created_at DESC`);

      // Parse JSON fields
      for (const job of jobs) {
        try { job.pre_edit_rating = job.pre_edit_rating ? JSON.parse(job.pre_edit_rating) : null; } catch { }
        try { job.post_edit_rating = job.post_edit_rating ? JSON.parse(job.post_edit_rating) : null; } catch { }
      }

      res.json(jobs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /jobs/:jobId ── Get job details
  router.get('/jobs/:jobId', (req: Request, res: Response) => {
    try {
      const job = queryOne(db, 'SELECT * FROM book_agent_jobs WHERE id = ?', [param(req, 'jobId')]);
      if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

      try { job.pre_edit_rating = job.pre_edit_rating ? JSON.parse(job.pre_edit_rating) : null; } catch { }
      try { job.post_edit_rating = job.post_edit_rating ? JSON.parse(job.post_edit_rating) : null; } catch { }
      try { job.report = job.report ? JSON.parse(job.report) : null; } catch { }

      const chapters = queryAll(db, 'SELECT id, title, sort_order, changes_summary, LENGTH(original_text) as original_length, LENGTH(edited_text) as edited_length FROM book_agent_chapters WHERE job_id = ? ORDER BY sort_order', [param(req, 'jobId')]);
      const tasks = queryAll(db, 'SELECT * FROM book_agent_tasks WHERE job_id = ? ORDER BY sort_order', [param(req, 'jobId')]);
      const followups = queryAll(db, 'SELECT * FROM book_agent_followups WHERE job_id = ? ORDER BY created_at', [param(req, 'jobId')]);
      for (const f of followups) {
        try { f.result_rating = f.result_rating ? JSON.parse(f.result_rating) : null; } catch { }
      }

      res.json({ ...job, chapters, tasks, followups });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /jobs/:jobId/logs ── Get job logs
  router.get('/jobs/:jobId/logs', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = queryAll(db, 'SELECT * FROM book_agent_logs WHERE job_id = ? ORDER BY created_at DESC LIMIT ?', [param(req, 'jobId'), limit]);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /jobs/:jobId/chapters/:chapterIndex ── Get chapter content
  router.get('/jobs/:jobId/chapters/:chapterIndex', (req: Request, res: Response) => {
    try {
      const chapter = queryOne(db, 'SELECT * FROM book_agent_chapters WHERE job_id = ? AND sort_order = ?',
        [param(req, 'jobId'), parseInt(param(req, 'chapterIndex'))]);
      if (!chapter) { res.status(404).json({ error: 'Chapter not found' }); return; }
      res.json(chapter);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /upload ── Upload book and start agent job
  router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }

      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!['.epub', '.pdf', '.txt', '.docx'].includes(ext)) {
        try { fs.unlinkSync(req.file.path); } catch { }
        res.status(400).json({ error: `Unsupported format: ${ext}. Supported: .epub, .pdf, .txt, .docx` });
        return;
      }

      const instructions = req.body.instructions || '';
      const provider = req.body.provider || 'openai';
      const model = req.body.model || 'gpt-4o';
      const apiKey = req.body.api_key || '';
      const baseUrl = req.body.base_url || '';
      const accountId = req.body.account_id || '';
      const gatewayId = req.body.gateway_id || '';
      const outputFormat = req.body.output_format || ext.replace('.', '') || 'epub';
      const temperature = parseFloat(req.body.temperature) || 0.7;

      if (!instructions.trim()) {
        try { fs.unlinkSync(req.file.path); } catch { }
        res.status(400).json({ error: 'Instructions are required. Use GET /prompt-guide for templates.' });
        return;
      }

      // Validate provider credentials before starting the job
      if (provider === 'cloudflare') {
        const token = apiKey || process.env.CLOUDFLARE_API_TOKEN || '';
        const cfAccountId = accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '';
        if (!token) {
          try { fs.unlinkSync(req.file.path); } catch { }
          res.status(400).json({ error: 'Cloudflare API token is required. Provide it in the form or set CLOUDFLARE_API_TOKEN env variable.' });
          return;
        }
        if (!cfAccountId) {
          try { fs.unlinkSync(req.file.path); } catch { }
          res.status(400).json({ error: 'Cloudflare Account ID is required. Provide it in the form or set CLOUDFLARE_ACCOUNT_ID env variable.' });
          return;
        }
      } else if (provider === 'openai') {
        if (!apiKey && !process.env.OPENAI_API_KEY) {
          try { fs.unlinkSync(req.file.path); } catch { }
          res.status(400).json({ error: 'OpenAI API key is required. Provide it in the form or set OPENAI_API_KEY env variable.' });
          return;
        }
      } else if (provider === 'anthropic') {
        if (!apiKey && !process.env.ANTHROPIC_API_KEY) {
          try { fs.unlinkSync(req.file.path); } catch { }
          res.status(400).json({ error: 'Anthropic API key is required. Provide it in the form or set ANTHROPIC_API_KEY env variable.' });
          return;
        }
      } else if (provider === 'gemini') {
        if (!apiKey && !process.env.GEMINI_API_KEY) {
          try { fs.unlinkSync(req.file.path); } catch { }
          res.status(400).json({ error: 'Gemini API key is required. Provide it in the form or set GEMINI_API_KEY env variable.' });
          return;
        }
      } else if (provider === 'mistral') {
        if (!apiKey && !process.env.MISTRAL_API_KEY) {
          try { fs.unlinkSync(req.file.path); } catch { }
          res.status(400).json({ error: 'Mistral API key is required. Provide it in the form or set MISTRAL_API_KEY env variable.' });
          return;
        }
      }

      // Parse the uploaded file
      let chapters: Array<{ title: string; text: string }> = [];
      if (ext === '.epub') {
        chapters = await extractEpubChapters(req.file.path);
      } else if (ext === '.pdf') {
        const text = await extractPdfText(req.file.path);
        if (!text.trim()) {
          try { fs.unlinkSync(req.file.path); } catch { }
          res.status(400).json({ error: 'Could not extract text from PDF. The PDF may be image-based (scanned). Try converting to EPUB or TXT first.' });
          return;
        }
        chapters = splitTextIntoChapters(text);
      } else if (ext === '.txt') {
        const text = fs.readFileSync(req.file.path, 'utf-8');
        chapters = splitTextIntoChapters(text);
      } else if (ext === '.docx') {
        const mammoth = await import('mammoth');
        const result = await mammoth.default.extractRawText({ path: req.file.path });
        chapters = splitTextIntoChapters(result.value);
      }

      // Clean up uploaded file
      try { fs.unlinkSync(req.file.path); } catch { }

      if (chapters.length === 0) {
        res.status(400).json({ error: 'No content found in the file.' });
        return;
      }

      // Create the job
      const jobId = uuid();
      const totalWords = chapters.reduce((sum, c) => sum + c.text.split(/\s+/).length, 0);

      withTransaction(db, () => {
        run(db, `INSERT INTO book_agent_jobs (id, original_filename, original_format, output_format, instructions,
          provider, model, api_key, base_url, account_id, gateway_id, temperature, status, total_chapters, total_words)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          [jobId, req.file!.originalname, ext.replace('.', ''), outputFormat, instructions,
           provider, model, apiKey, baseUrl, accountId, gatewayId, temperature, chapters.length, totalWords]);

        for (let i = 0; i < chapters.length; i++) {
          run(db, `INSERT INTO book_agent_chapters (id, job_id, sort_order, title, original_text) VALUES (?, ?, ?, ?, ?)`,
            [uuid(), jobId, i, chapters[i].title, chapters[i].text]);
        }

        for (let i = 0; i < chapters.length; i++) {
          run(db, `INSERT INTO book_agent_tasks (id, job_id, chapter_index, sort_order, title, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
            [uuid(), jobId, i, i, `Edit: ${chapters[i].title}`]);
        }
      });

      // Start processing in background
      const agentConfig: AgentConfig = { provider, model, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined, temperature, accountId: accountId || undefined, gatewayId: gatewayId || undefined };
      activeJobs.set(jobId, { cancel: false });
      processAgentJob(db, jobId, agentConfig).catch(err => {
        console.error('[BookAgent] Job failed:', err);
      });

      res.json({
        job_id: jobId,
        status: 'queued',
        total_chapters: chapters.length,
        total_words: totalWords,
        message: `Agent started. Processing ${chapters.length} chapters (${totalWords.toLocaleString()} words). Check status at GET /jobs/${jobId}`,
      });
    } catch (err: any) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { } }
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /jobs/:jobId/followup ── Submit follow-up instructions
  router.post('/jobs/:jobId/followup', async (req: Request, res: Response) => {
    try {
      const job = queryOne(db, 'SELECT * FROM book_agent_jobs WHERE id = ?', [param(req, 'jobId')]);
      if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
      if (job.status !== 'completed') {
        res.status(400).json({ error: `Job is ${job.status}. Follow-ups only work on completed jobs.` });
        return;
      }

      const { instructions, re_rate = true, provider, model, api_key, base_url } = req.body;
      if (!instructions?.trim()) {
        res.status(400).json({ error: 'Instructions are required' });
        return;
      }

      const followUpId = uuid();
      run(db, `INSERT INTO book_agent_followups (id, job_id, instructions, re_rate, status) VALUES (?, ?, ?, ?, 'queued')`,
        [followUpId, param(req, 'jobId'), instructions, re_rate ? 1 : 0]);

      const agentConfig: AgentConfig = {
        provider: provider || job.provider,
        model: model || job.model,
        apiKey: api_key || job.api_key || undefined,
        baseUrl: base_url || job.base_url || undefined,
        temperature: job.temperature || 0.7,
        accountId: job.account_id || undefined,
        gatewayId: job.gateway_id || undefined,
      };

      activeJobs.set(followUpId, { cancel: false });
      processFollowUp(db, param(req, 'jobId'), followUpId, agentConfig).catch(err => {
        console.error('[BookAgent] Follow-up failed:', err);
      });

      res.json({
        followup_id: followUpId,
        job_id: param(req, 'jobId'),
        status: 'queued',
        message: 'Follow-up instructions submitted. The agent will process all chapters with your new instructions.',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /jobs/:jobId/cancel ── Cancel a running job
  router.post('/jobs/:jobId/cancel', (req: Request, res: Response) => {
    try {
      const job = queryOne(db, 'SELECT * FROM book_agent_jobs WHERE id = ?', [param(req, 'jobId')]);
      if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

      const ctrl = activeJobs.get(param(req, 'jobId'));
      if (ctrl) ctrl.cancel = true;

      run(db, `UPDATE book_agent_jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, [param(req, 'jobId')]);
      res.json({ ok: true, message: 'Cancellation requested' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /jobs/:jobId/download ── Download the output file
  router.get('/jobs/:jobId/download', (req: Request, res: Response) => {
    try {
      const job = queryOne(db, 'SELECT * FROM book_agent_jobs WHERE id = ?', [param(req, 'jobId')]);
      if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
      if (!job.output_path || !fs.existsSync(job.output_path)) {
        res.status(404).json({ error: 'Output file not ready or not found' });
        return;
      }

      const filename = `${(job.original_filename || 'book').replace(/\.[^.]+$/, '')}_edited.${job.output_format || 'epub'}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', job.output_format === 'epub' ? 'application/epub+zip' : 'text/plain');
      const stream = fs.createReadStream(job.output_path);
      stream.pipe(res);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /jobs/:jobId ── Delete a job and its data
  router.delete('/jobs/:jobId', (req: Request, res: Response) => {
    try {
      const job = queryOne(db, 'SELECT * FROM book_agent_jobs WHERE id = ?', [param(req, 'jobId')]);
      if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

      // Cancel if running
      const ctrl = activeJobs.get(param(req, 'jobId'));
      if (ctrl) ctrl.cancel = true;

      // Delete output file
      if (job.output_path && fs.existsSync(job.output_path)) {
        try { fs.unlinkSync(job.output_path); } catch { }
      }

      withTransaction(db, () => {
        run(db, 'DELETE FROM book_agent_logs WHERE job_id = ?', [param(req, 'jobId')]);
        run(db, 'DELETE FROM book_agent_tasks WHERE job_id = ?', [param(req, 'jobId')]);
        run(db, 'DELETE FROM book_agent_followups WHERE job_id = ?', [param(req, 'jobId')]);
        run(db, 'DELETE FROM book_agent_chapters WHERE job_id = ?', [param(req, 'jobId')]);
        run(db, 'DELETE FROM book_agent_jobs WHERE id = ?', [param(req, 'jobId')]);
      });

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /models ── List supported providers and models
  router.get('/models', (_req: Request, res: Response) => {
    res.json({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
          requires_key: true,
          env_key: 'OPENAI_API_KEY',
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
          requires_key: true,
          env_key: 'ANTHROPIC_API_KEY',
        },
        {
          id: 'gemini',
          name: 'Google Gemini',
          models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
          requires_key: true,
          env_key: 'GEMINI_API_KEY',
        },
        {
          id: 'mistral',
          name: 'Mistral AI',
          models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
          requires_key: true,
          env_key: 'MISTRAL_API_KEY',
        },
        {
          id: 'openai-compatible',
          name: 'OpenAI-Compatible (Custom)',
          models: [],
          requires_key: true,
          supports_base_url: true,
          description: 'Any OpenAI-compatible API (Ollama, LM Studio, vLLM, etc.)',
        },
        {
          id: 'cloudflare',
          name: 'Cloudflare Workers AI',
          models: [
            '@cf/moonshotai/kimi-k2.5',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            '@cf/meta/llama-4-scout-17b-16e-instruct',
            '@cf/qwen/qwen2.5-coder-32b-instruct',
            '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
            '@cf/google/gemma-3-12b-it',
            '@cf/mistralai/mistral-small-3.1-24b-instruct',
          ],
          requires_key: true,
          env_key: 'CLOUDFLARE_API_TOKEN',
          supports_account_id: true,
          supports_gateway_id: true,
          description: 'Cloudflare Workers AI with optional AI Gateway. Requires Account ID and API Token.',
        },
      ],
    });
  });

  return router;
}
