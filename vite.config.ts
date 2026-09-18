import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const demoRoot = dirname(fileURLToPath(import.meta.url));
const superdocPackageRoot = realpathSync(resolve(demoRoot, 'node_modules/superdoc-next'));
const docxEngineRoot = realpathSync(resolve(superdocPackageRoot, '../@superdoc/docx-engine'));
const workerRoute = '/node_modules/@superdoc/docx-engine/dist/assets/';

function servePublishedWorkerAssets() {
  return {
    name: 'serve-published-superdoc-worker-assets',
    configureServer(server: { middlewares: { use: (handler: (request: any, response: any, next: () => void) => void) => void } }) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (!pathname.startsWith(workerRoute)) return next();
        const fileName = pathname.slice(workerRoute.length);
        if (!/^(?:browser|collaboration)-worker-entry-[A-Za-z0-9_-]+\.js$/.test(fileName)) return next();
        try {
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.end(await readFile(join(docxEngineRoot, 'dist/assets', fileName)));
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), servePublishedWorkerAssets()],
  server: { port: 5190, strictPort: true },
});
