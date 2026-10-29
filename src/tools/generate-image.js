import { logger } from '../utils/logger.js';
import { getPage, isBrowserConnected, setBrowser } from '../browser/connect.js';
import { launchKiaraProfile } from '../browser/launch-profile.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { get, getFlowHome } from '../utils/config.js';
import fs from 'fs';
import path from 'path';

// Settings cache — skip UI work if model+ratio unchanged (huge speedup)
let cachedSettings = { model: null, ratio: null };

function selectModel(requested) {
  const available = get('imageModels', {});
  if (!requested || requested === 'auto') return 'Nano Banana 2 Lite';
  if (available[requested]) return requested;
  const low = String(requested).toLowerCase();
  if (low.includes('lite')) return 'Nano Banana 2 Lite';
  if (low.includes('pro')) return 'Nano Banana Pro';
  if (low.includes('nb2') || low.includes('banana-2')) return 'Nano Banana 2';
  if (low.includes('imagen')) return 'Imagen 4';
  return 'Nano Banana 2 Lite';
}

function selectRatio(requested) {
  const ratios = get('ratios', ['16:9', '9:16', '1:1', '4:3', '3:4']);
  if (!requested) return '16:9';
  if (ratios.includes(requested)) return requested;
  if (requested.includes('9') && requested.includes('16')) return requested.startsWith('9') ? '9:16' : '16:9';
  if (requested.includes('1:1')) return '1:1';
  return '16:9';
}

export async function handleGenerateImage(args) {
  const autoConfirm = args.auto_confirm === true;
  const targetModel = selectModel(args.model);
  const targetRatio = selectRatio(args.ratio);

  const job = jobQueue.createJob('image_generation', {
    prompt: args.prompt,
    model: targetModel,
    ratio: targetRatio,
    auto_confirm: autoConfirm,
    quantity: args.quantity || 1,
    outputFolder: args.output_folder,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const T0 = Date.now();
    const mark = (label) => logger.info(`⏱ ${label}`, { elapsedMs: Date.now() - T0 });

    if (!isBrowserConnected()) {
      logger.info('Auto-connecting to Chrome for image generation...');
      const result = await launchKiaraProfile(false);
      if (result?.browser) setBrowser(result.browser);
    }
    mark('connect-done');

    const page = getPage();

    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });
    mark('project-done');

    await page.keyboard.press('Escape').catch(() => {});

    // Settings: fast path — if same as last time, skip DOM read entirely
    const needSettingsCheck = cachedSettings.model !== targetModel || cachedSettings.ratio !== targetRatio;
    if (needSettingsCheck) {
      const settingsBtn = page.locator('.settings-trigger-button').first();
      if (await settingsBtn.isVisible().catch(() => false)) {
        const btnText = (await settingsBtn.innerText().catch(() => '')) || '';
        const needsImageMode = btnText.includes('Video') || (!btnText.includes('Banana') && !btnText.includes('Imagen'));
        const needsRatioSwitch = targetRatio && !btnText.includes(targetRatio.replace(':', '_')) && !btnText.includes(targetRatio);
        const needsModelSwitch = targetModel && !btnText.includes(targetModel);

        if (needsImageMode || needsRatioSwitch || needsModelSwitch) {
          logger.info('Adjusting settings in UI...', { targetModel, targetRatio });
          await settingsBtn.click();
          await page.waitForTimeout(150);

          if (needsImageMode) {
            const imgToggle = page.locator('.cdk-overlay-container mat-button-toggle, .cdk-overlay-container button').filter({ hasText: /^image\s*Image/i }).first();
            if (await imgToggle.isVisible().catch(() => false)) {
              await imgToggle.click();
              await page.waitForTimeout(80);
            }
          }
          if (targetRatio && needsRatioSwitch) {
            const ratioToggle = page.locator('.cdk-overlay-container mat-button-toggle, .cdk-overlay-container button').filter({ hasText: targetRatio }).first();
            if (await ratioToggle.isVisible().catch(() => false)) {
              await ratioToggle.click();
              await page.waitForTimeout(80);
            }
          }
          if (needsModelSwitch) {
            const modelDropdown = page.locator('.cdk-overlay-container button[aria-label*="model"]').first();
            if (await modelDropdown.isVisible().catch(() => false)) {
              await modelDropdown.click();
              await page.waitForTimeout(150);
              const modelOption = page.locator('.cdk-overlay-pane').last().locator('*').filter({ hasText: new RegExp(targetModel, 'i') }).first();
              if (await modelOption.isVisible().catch(() => false)) {
                await modelOption.click();
                await page.waitForTimeout(120);
              }
            }
          }
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
      cachedSettings = { model: targetModel, ratio: targetRatio };
    }
    mark('settings-done');

    // Fill prompt — wait for editor explicitly, no blind sleeps.
    // Force-focus (JS focus + force click) to bypass transient overlays
    // like credit-cost tooltips that intercept pointer events.
    const input = page.locator('.ProseMirror').first();
    await input.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    // Fill prompt in ONE call: fill() focuses + selects + replaces text at once.
    // Keyboard path is fallback only (ProseMirror sometimes ignores fill).
    await page.keyboard.press('Escape').catch(() => {});
    let promptSet = false;
    try {
      await input.fill(args.prompt, { timeout: 4000 });
      promptSet = true;
    } catch {
      await input.evaluate((el) => el.focus()).catch(() => {});
      await input.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(args.prompt);
    }
    // Single combined DOM check: editor text + submit enabled in ONE round trip.
    const uiState = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror');
      const b = document.querySelector('button[aria-label="Start generation"]');
      return {
        hasText: !!el && (el.textContent || '').trim().length > 10,
        submitEnabled: !!b && !b.disabled,
      };
    }).catch(() => ({ hasText: false, submitEnabled: false }));
    if (!uiState.hasText) {
      await input.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await input.pressSequentially(args.prompt, { delay: 8 });
    }

    const generateBtnLocator = page.locator('button:has(:text-is("arrow_forward")), button[aria-label="Start generation"], button[aria-label*="Generate"]').first();
    if (!uiState.submitEnabled) {
      await page.waitForFunction(() => {
        const b = document.querySelector('button[aria-label="Start generation"]') ||
                  document.querySelector('button:has(:text-is("arrow_forward"))');
        return b && !b.disabled;
      }, { timeout: 4000 }).catch(() => {});
    }
    mark('prompt-ready');

    const defaultProjectImages = path.join(getFlowHome(), 'generated_images');
    if (!fs.existsSync(defaultProjectImages)) fs.mkdirSync(defaultProjectImages, { recursive: true });
    const outputDir = args.output_folder || defaultProjectImages;

    const downloadedFiles = [];
    const seenUrls = new Set();
    // Baseline all existing images currently in page DOM across all frames
    for (const frame of page.frames()) {
      try {
        const existing = await frame.evaluate(() => {
          return Array.from(document.querySelectorAll('img, video'))
            .map(el => el.src || el.currentSrc || el.getAttribute('poster'))
            .filter(Boolean);
        });
        existing.forEach(u => seenUrls.add(u));
      } catch {}
    }
    logger.info('Baselined existing project images', { count: seenUrls.size });

    const GRACE_MS = 2500;
    let clickTime = 0;

    // Single capture path: network stream only.
    let resolveCapture = null;
    const capturePromise = new Promise((res) => { resolveCapture = res; });
    const responseHandler = async (response) => {
      try {
        const url = response.url();
        const isTargetImage = (
          url.includes('flow-content.google') ||
          url.includes('googleusercontent.com') ||
          url.includes('/asb/')
        ) && response.status() === 200;
        if (!isTargetImage) return;
        if (!clickTime || Date.now() - clickTime < GRACE_MS) return;
        if (seenUrls.has(url)) return;
        const buffer = await response.body();
        if (buffer && buffer.length > 30000) {
          seenUrls.add(url);
          const ext = (response.headers()['content-type'] || '').includes('png') ? '.png' : '.jpg';
          const destPath = path.join(outputDir, `flow_${Date.now()}_net${ext}`);
          fs.writeFileSync(destPath, buffer);
          if (downloadedFiles.length === 0) downloadedFiles.push(destPath);
          logger.info('Image captured via network stream', { path: destPath, size: buffer.length });
          if (resolveCapture) resolveCapture();
        }
      } catch {}
    };
    page.on('response', responseHandler);

    logger.info('Clicking Generate...');
    try {
      await generateBtnLocator.waitFor({ state: 'visible', timeout: 5000 });
      await generateBtnLocator.click({ timeout: 5000 });
    } catch {
      await page.evaluate(() => {
        const b = document.querySelector('button[aria-label="Start generation"]') ||
                  Array.from(document.querySelectorAll('button')).find(btn => (btn.innerText || '').includes('arrow_forward'));
        if (b) b.click();
      });
    }
    clickTime = Date.now();
    mark('submitted');

    // Approve window — poll for any confirmation/credit dialogs
    const approveEnd = Date.now() + 2500;
    while (Date.now() < approveEnd && downloadedFiles.length === 0) {
      for (const frame of page.frames()) {
        const approveBtn = frame.locator('button').filter({ hasText: /Approve|Accepter|Generate|Confirm|Approva/i }).first();
        if (await approveBtn.isVisible().catch(() => false)) {
          await approveBtn.click().catch(() => {});
          logger.info('Approved generation confirmation dialog');
          break;
        }
      }
      await page.waitForTimeout(200);
    }

    // Wait for capture with instant wakeup + DOM poll fallback + hard timeout cap.
    const timeoutMs = get('generationTimeoutMs', 75000);
    const timeoutPromise = new Promise((res) => setTimeout(res, timeoutMs));

    let domInterval = null;
    const domPollPromise = new Promise((res) => {
      domInterval = setInterval(async () => {
        if (downloadedFiles.length > 0 || !clickTime || Date.now() - clickTime < 4000) return;
        try {
          for (const frame of page.frames()) {
            const newImgs = await frame.evaluate(() => {
              return Array.from(document.querySelectorAll('img'))
                .filter(img => (img.naturalWidth > 200 || img.width > 200))
                .map(img => img.src)
                .filter(Boolean);
            });
            for (const src of newImgs) {
              if (!seenUrls.has(src) && (src.includes('googleusercontent.com') || src.includes('flow-content.google') || src.startsWith('blob:') || src.startsWith('data:'))) {
                seenUrls.add(src);
                if (src.startsWith('data:image/')) {
                  const base64 = src.split(',')[1];
                  const buf = Buffer.from(base64, 'base64');
                  if (buf.length > 30000) {
                    const dest = path.join(outputDir, `flow_${Date.now()}_dom.jpg`);
                    fs.writeFileSync(dest, buf);
                    if (downloadedFiles.length === 0) downloadedFiles.push(dest);
                    if (resolveCapture) resolveCapture();
                    res();
                    return;
                  }
                } else {
                  const base64Data = await frame.evaluate(async (s) => {
                    try {
                      const r = await fetch(s);
                      const b = await r.blob();
                      return new Promise(resolve => {
                        const fr = new FileReader();
                        fr.onloadend = () => resolve(fr.result);
                        fr.readAsDataURL(b);
                      });
                    } catch { return null; }
                  }, src);
                  if (base64Data && base64Data.includes(',')) {
                    const buf = Buffer.from(base64Data.split(',')[1], 'base64');
                    if (buf.length > 30000) {
                      const dest = path.join(outputDir, `flow_${Date.now()}_dom.jpg`);
                      fs.writeFileSync(dest, buf);
                      if (downloadedFiles.length === 0) downloadedFiles.push(dest);
                      if (resolveCapture) resolveCapture();
                      res();
                      return;
                    }
                  }
                }
              }
            }
          }
        } catch {}
      }, 1500);
    });

    await Promise.race([capturePromise, domPollPromise, timeoutPromise]);
    if (domInterval) clearInterval(domInterval);
    page.off('response', responseHandler);
    mark('captured');

    if (downloadedFiles.length === 0) {
      throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, 'Failed to capture generated image (network stream timeout).');
    }

    // NO verification re-read, NO screenshot — return immediately for speed
    saveMetadata(job.id, {
      type: 'image',
      model: targetModel,
      ratio: targetRatio,
      auto_confirm: true,
      quantity: args.quantity || 1,
      prompt: args.prompt,
      files: downloadedFiles,
      jobId: job.id,
      imageUrls: downloadedFiles,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'image',
      account: get('expectedAccount'),
      model_used: targetModel,
      ratio: targetRatio,
      prompt: args.prompt,
      files: downloadedFiles,
      image_count: downloadedFiles.length,
      credits_consumed: false,
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    try { page?.off?.('response', () => {}); } catch {}
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
