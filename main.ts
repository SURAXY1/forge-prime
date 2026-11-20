// forge-prime entrypoint: bind an ephemeral port, register it with the
// harness environment, then serve until the environment reports done.
import { buildServer } from './server.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('uncaughtException', (e) => console.error('[forge-prime] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[forge-prime] unhandled', e));

async function announce(port) {
  let wait = 100;
  for (;;) {
    try {
      const res = await fetch(ENV_ORIGIN + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) });
      await res.arrayBuffer().catch(() => null);
      if (res.ok || res.status === 409) return;
      console.error('[forge-prime] register answered HTTP ' + res.status);
    } catch (e) {
      console.error('[forge-prime] register failed: ' + ((e && e.message) || e));
    }
    await pause(wait);
    wait = Math.min(wait * 2, 2000);
  }
}
async function awaitDone() {
  let wait = 250;
  for (;;) {
    await pause(wait);
    try {
      const res = await fetch(ENV_ORIGIN + '/done');
      const body = await res.json().catch(() => null);
      if (body && body.done === true) return;
    } catch {
      // environment busy; keep polling
    }
    wait = Math.min(Math.round(wait * 1.5), 2000);
  }
}

const server = buildServer();
const standalonePort = ENV_ORIGIN === '' && process.env.PORT ? Number(process.env.PORT) : 0;
server.listen(standalonePort, '0.0.0.0', async () => {
  const port = server.address().port;
  console.error('[forge-prime] listening on ' + port);
  if (ENV_ORIGIN === '') {
    if (process.env.PORT) return;
    console.error('[forge-prime] MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }
  await announce(port);
  await awaitDone();
  process.exit(0);
});
