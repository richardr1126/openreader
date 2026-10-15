/**
 * The per-launch secret the desktop shell generates and passes to this process.
 * It is the fifth authentication boundary (desktop shell to Next.js) and is read
 * only here. Unset means the deployment is not a desktop install.
 */
export function configuredDesktopLaunchToken(): string | null {
  const value = process.env.DESKTOP_LAUNCH_TOKEN?.trim();
  return value ? value : null;
}
