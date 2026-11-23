// Runs inside the disposable candidate checkout, including for older Workplot versions.
import { URL } from 'node:url';
import { registerHooks } from 'node:module';
import process from 'node:process';
const port = Number(process.env.WORKPLOT_QA_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4310)
  throw Error('Invalid candidate QA port');
const fixture = new URL('./qa/server.mjs', import.meta.url).href;
const routes = new URL('./apps/server/dist/studio-routes.js', import.meta.url)
  .href;
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (url !== fixture && url !== routes) return result;
    let source = String(result.source);
    if (url === fixture && !source.includes('WORKPLOT_QA_PORT')) {
      source = source
        .replaceAll('port: 5173', 'port: ' + port)
        .replace(
          'process.send?.',
          `console.log('Workplot QA port ${port}');process.send?.`,
        );
    }
    if (url === routes)
      source = source.replaceAll('127.0.0.1:5173', '127.0.0.1:' + port);
    return { ...result, source };
  },
});
await import(fixture);
