import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';

export async function handleUseFlowTool(args) {
  const page = getPage();
  const toolName = args.tool_name || args.name;

  if (!toolName) {
    throw new Error('Tool name is required');
  }

  await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });

  // Navigate to Outils sidebar
  await navigateToSidebar(page, 'Outils');
  await page.waitForTimeout(700);

  // Find the tool in the tools section
  const toolLocator = page.locator(
    `a:has-text("${toolName}"), button:has-text("${toolName}"), text="${toolName}"`
  ).first();

  if (await toolLocator.isVisible().catch(() => false)) {
    await toolLocator.click();
    await page.waitForTimeout(800);
  } else {
    // Fallback: try direct URL
    const toolSlug = toolName.toLowerCase().replace(/\s+/g, '-');
    const toolUrl = `https://labs.google/fx/tools/flow/tools/${toolSlug}`;
    await page.goto(toolUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(700);
  }

  const elements = await detectPageElements(page);

  if (args.params && typeof args.params === 'object') {
    for (const [key, value] of Object.entries(args.params)) {
      if (typeof value === 'string') {
        const input = await page.$(
          `[name="${key}"], [placeholder="${key}"], [aria-label="${key}"]`
        );
        if (input) {
          await input.click();
          await input.fill('');
          await page.waitForTimeout(90);
          await input.type(value, { delay: 10 });
        }
      }
    }
  }

  return {
    status: 'tool_opened',
    tool: toolName,
    url: page.url(),
    elements,
    screenshot: null,
  };
}
