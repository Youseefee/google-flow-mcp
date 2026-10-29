import { logger } from '../utils/logger.js';
import { getPage, isBrowserConnected, setBrowser } from '../browser/connect.js';
import { launchKiaraProfile } from '../browser/launch-profile.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { prepareDownload, saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

function selectVideoModel(requested) {
  const available = get('videoModels', {});
  if (!requested || requested === 'auto') {
    return available['Omni 1.1 Flash'] ? 'Omni 1.1 Flash' : 'Veo 3.1 - Fast';
  }
  if (available[requested]) return requested;
  const low = String(requested).toLowerCase().replace(/\s+/g, ' ').trim();
  const hasOmni = low.includes('omni');
  const hasFlash = low.includes('flash');
  const has11 = low.includes('1.1');
  if (hasOmni && hasFlash) {
    if (available['Omni 1.1 Flash']) return 'Omni 1.1 Flash';
    if (has11 && available['Omni Flash 1.1']) return 'Omni Flash 1.1';
    if (available['Omni Flash']) return 'Omni Flash';
  }
  if (requested === 'quality' || requested === 'premium') return 'Veo 3.1 - Quality';
  if (requested === 'fast' || requested === 'speed') return 'Veo 3.1 - Fast';
  if (requested === 'lite' || requested === 'test') return 'Veo 3.1 - Lite';
  if (requested === 'flash' || requested === 'simple') {
    return available['Omni 1.1 Flash'] || 'Omni Flash';
  }
  return null;
}

export async function handleGenerateVideo(args) {
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('video_generation', {
    prompt: args.prompt,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    duration: args.duration || '4s',
    auto_confirm: autoConfirm,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);

    if (!isBrowserConnected()) {
      logger.info('Auto-connecting to Chrome for video generation...');
      const result = await launchKiaraProfile(false);
      if (result?.browser) setBrowser(result.browser);
    }

    const page = getPage();

    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });

    const model = selectVideoModel(args.model);
    if (!model) {
      const available = Object.keys(get('videoModels', {}));
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Video model "${args.model}" not available. Available: ${available.join(', ')}`,
        { requested: args.model, available });
    }
    logger.info('Using video model', { model });

    const duration = args.duration || '4s';

    // Find prompt input (agent bar, contenteditable/textarea)
    let promptInput = null;
    const promptCandidates = [
      page.locator('[contenteditable="true"]:visible').first(),
      page.locator('textarea:visible').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('textarea').first(),
    ];
    for (const candidate of promptCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        promptInput = candidate;
        break;
      }
    }
    if (!promptInput) {
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find prompt input for video');
    }

    // Flow is agent-first: an imperative prompt that names the model, duration
    // and "video" makes the agent generate directly instead of asking questions.
    // The fidelity clause binds the agent to the user's description verbatim.
    const imperativePrompt =
      `Genera subito un video di ${duration} con il modello ${model}, senza farmi domande e senza chiedere chiarimenti. ` +
      `Attieniti FEDELMENTE a questa descrizione: includi TUTTI gli elementi, soggetti, azioni e ` +
      `dettagli indicati, non aggiungere nulla che non sia richiesto e non omettere nulla. ` +
      `Descrizione: ${args.prompt}`;

    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    await promptInput.click();
    // Fast paste (no char-by-char typing): fill for inputs/textareas,
    // select-all + insertText fallback for contenteditable editors.
    try {
      await promptInput.fill(imperativePrompt, { timeout: 5000 });
    } catch {
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(imperativePrompt);
    }

    // DECISION POINT — without auto_confirm we stop before spending credits.
    if (!autoConfirm) {
    const setupScreenshot = null;
      const result = {
        status: 'ready_for_confirmation',
        type: 'video',
        message: 'Prompt video pronto. Nessun credito consumato. ' +
          'Per generare (consuma crediti Flow) richiama con auto_confirm=true.',
        model_used: model,
        duration,
        prompt: args.prompt,
        account: get('expectedAccount'),
        screenshot: null,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // ⚠️ CREDITS: click submit (icon text is exactly "arrow_forward").
    logger.info('⚠️ auto_confirm=true — invio generazione video, consuma crediti');
    const submit = page.locator('button:has(:text-is("arrow_forward"))').first();
    // The submit can take a moment to render in a freshly created project —
    // wait for it instead of checking once.
    try {
      await submit.waitFor({ state: 'visible', timeout: 12000 });
    } catch {
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Video submit button not found');
    }
    // Baseline media before generating — Flow's UI assets and other-session
    // thumbnails share the same media endpoint, so we keep only the NEW video.
    const baselineUuids = [];
    for (const frame of page.frames()) {
      const b = await frame.evaluate(() => {
        const s = new Set();
        document.querySelectorAll('img,video').forEach(el => {
          const src = el.src || el.currentSrc || el.getAttribute('poster') || '';
          const m = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
          if (m) s.add(m[1]);
        });
        return [...s];
      }).catch(() => []);
      baselineUuids.push(...b);
    }

    await submit.click();

    // Event-driven video detection: capture the video bytes the moment they
    // arrive on the network (fires instantly, no poll granularity).
    // Fallback poll loop below stays as safety net for DOM-only appearances.
    let networkVideoSrc = null;
    const videoResponseHandler = async (response) => {
      try {
        if (response.status() !== 200) return;
        const url = response.url();
        if (url.includes('flow-content.google/video')) {
          networkVideoSrc = url;
          logger.info('Video stream detected on network', { src: url.substring(0, 100) });
        }
      } catch {}
    };
    page.on('response', videoResponseHandler);

    // Poll for the generated video. Two things happen during this window and
    // both can appear late, so we handle them EACH iteration:
    //  1) A credit-confirmation dialog ("...che costa N crediti?" → Approva).
    //     It shows up seconds AFTER submit (the agent reasons first), so a
    //     fixed short wait misses it — click it whenever it appears.
    //  2) The finished video, which is slow (Veo takes minutes) and may live in
    //     any frame, as a <video> element or an <img> poster on the Flow media
    //     endpoint (media.getMediaUrlRedirect?name=UUID).
    const genTimeoutMs = get('videoGenerationTimeoutMs', 600000);
    const genStart = Date.now();
    let mediaUuids = [];
    let videoSrc = null;
    let approved = false;

    const scanFrame = (frame) => frame.evaluate(() => {
      const uuids = new Set();
      let vsrc = null;
      document.querySelectorAll('video').forEach(v => {
        const s = v.src || v.currentSrc || '';
        if (s) vsrc = s;
        const m = s.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (m) uuids.add(m[1]);
        const pm = (v.getAttribute('poster') || '').match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (pm) uuids.add(pm[1]);
      });
      document.querySelectorAll('img').forEach(img => {
        const m = (img.src || '').match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (m && img.width > 150) uuids.add(m[1]);
      });
      return { uuids: [...uuids], vsrc };
    }).catch(() => ({ uuids: [], vsrc: null }));

    while (Date.now() - genStart < genTimeoutMs) {
      await page.waitForTimeout(1000);

      // 1) Approve the credit dialog if present (any iteration, any frame).
      //    Multilingual: IT Approva, FR Approuver/Accepter, EN Approve/Generate/Confirm.
      if (!approved) {
        for (const frame of page.frames()) {
          let clicked = false;
          for (const txt of ['Approva', 'Approuver', 'Approve', 'Accepter', 'Generate', 'Confirm']) {
            const approve = frame.getByText(txt, { exact: txt === 'Approva' }).first();
            if (await approve.isVisible().catch(() => false)) {
              await approve.click().catch(() => {});
              approved = true;
              clicked = true;
              logger.info('Confirmation dialog approved (credits spent)', { txt });
              break;
            }
          }
          if (clicked) break;
        }
      }

      // 2) Scan every frame for the produced media.
      const uuids = new Set();
      for (const frame of page.frames()) {
        const r = await scanFrame(frame);
        if (r.vsrc) videoSrc = r.vsrc;
        r.uuids.forEach(u => { if (!baselineUuids.includes(u)) uuids.add(u); });
      }
      if (uuids.size) {
        mediaUuids = [...uuids];
        logger.info('Video media detected', { count: mediaUuids.length, hasVideoEl: !!videoSrc, approved });
      }
      // Break as soon as we have ANY playable source — don't wait for UUIDs.
      // Direct CDN URLs (flow-content.google/video/...) carry no UUID but are fully downloadable.
      // networkVideoSrc fires instantly on arrival (event-driven, no poll delay).
      if (networkVideoSrc && !videoSrc) videoSrc = networkVideoSrc;
      if (videoSrc || uuids.size) break;

      const elapsed = Math.round((Date.now() - genStart) / 1000);
      if (elapsed % 30 < 5) {
        logger.info('Still waiting for video...', { elapsed });
      }
    }
    page.off('response', videoResponseHandler);

    if (networkVideoSrc && !videoSrc) videoSrc = networkVideoSrc;
    if (!mediaUuids.length && !videoSrc) {
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        'Generation completed but no video was detected in the DOM. Check the Flow project library.');
    }

    // Download via authenticated session. Try the media endpoint for each UUID
    // and keep whatever comes back as video/*.
    const outputDir = args.output_folder || prepareDownload('video', model, job.id).dir;
    if (args.output_folder && !fs.existsSync(args.output_folder)) {
      fs.mkdirSync(args.output_folder, { recursive: true });
    }
    const downloadedFiles = [];

    for (const uuid of mediaUuids) {
      try {
        const response = await page.request.get(
          `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${uuid}`,
          { timeout: 60000 }
        );
        if (response && response.ok()) {
          const ct = response.headers()['content-type'] || '';
          if (ct.startsWith('video/')) {
            const buffer = await response.body();
            const destPath = path.join(outputDir, `flow_${uuid.substring(0, 8)}_${job.id}.mp4`);
            fs.writeFileSync(destPath, buffer);
            downloadedFiles.push(destPath);
            logger.info('Video downloaded', { uuid, size: buffer.length, path: destPath });
          }
        }
      } catch (err) {
        logger.warn('Failed to download video candidate', { uuid, error: err.message });
      }
    }

    // Fallback: direct CDN URL (flow-content.google/video/...?Expires=...&Signature=...)
    // The <video> element src is already a signed, authenticated URL — download it directly.
    if (!downloadedFiles.length && videoSrc) {
      try {
        logger.info('Trying direct videoSrc download', { src: videoSrc.substring(0, 100) });
        const response = await page.request.get(videoSrc, { timeout: 120000 });
        if (response && response.ok()) {
          const buffer = await response.body();
          if (buffer && buffer.length > 50000) {
            const destPath = path.join(outputDir, `flow_video_${job.id}.mp4`);
            fs.writeFileSync(destPath, buffer);
            downloadedFiles.push(destPath);
            logger.info('Video downloaded via direct src', { size: buffer.length, path: destPath });
          }
        }
      } catch (err) {
        logger.warn('Direct videoSrc download failed', { error: err.message });
      }
    }

    if (!downloadedFiles.length) {
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED,
        `Video generated but download failed. UUIDs seen: ${mediaUuids.join(', ') || 'none'}; videoSrc: ${videoSrc || 'none'}`);
    }

    saveMetadata(job.id, {
      type: 'video', model, duration, auto_confirm: true,
      prompt: args.prompt, files: downloadedFiles, jobId: job.id, mediaUuids,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'video',
      account: get('expectedAccount'),
      model_used: model,
      duration,
      prompt: args.prompt,
      files: downloadedFiles,
      video_count: downloadedFiles.length,
      credits_consumed: true,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
