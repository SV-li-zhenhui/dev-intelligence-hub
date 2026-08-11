export const WINDOWS_IME_ISOLATION_ARGUMENT =
  "--disable-features=TSFImeSupport";

// Focused controls can activate a host TSF daemon that inherits and locks the
// otherwise disposable Playwright profile after the browser has exited.
export function validationBrowserLaunchOptions(
  options = {},
  platform = process.platform,
) {
  const launchOptions = { ...options };
  if (platform !== "win32") return launchOptions;
  const args = Array.isArray(options.args) ? [...options.args] : [];
  if (!args.includes(WINDOWS_IME_ISOLATION_ARGUMENT)) {
    args.push(WINDOWS_IME_ISOLATION_ARGUMENT);
  }
  launchOptions.args = args;
  return launchOptions;
}
