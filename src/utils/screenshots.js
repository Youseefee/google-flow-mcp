// Screenshots DISABLED by user request — no-op for max speed.
// All takeScreenshot calls return null instantly, no disk IO, no page.screenshot.
export async function takeScreenshot(page, name) {
  return null;
}
export function getLatestScreenshot(namePattern) {
  return null;
}
