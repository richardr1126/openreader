/**
 * Next.js startup hook. On a long-lived self-hosted server we run the task
 * scheduler in-process. On Vercel (serverless, no persistent process) there is
 * nothing to keep a loop alive, so a cron route drives the ticks instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation.node');
  }
}
