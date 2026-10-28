import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import babelTraverse from '@babel/traverse';

// A name used but never declared only fails when that line runs (a click on
// a rarely used button), so catch it here instead.
const traverse = babelTraverse.default ?? babelTraverse;
const ROOT = new URL('../../', import.meta.url).pathname;
const BROWSER = [
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getSelection', 'Notification', 'AudioContext', 'webkitAudioContext', 'MediaRecorder',
  'FileReader', 'Blob', 'File', 'Image', 'HTMLElement', 'CustomEvent', 'alert', 'confirm', 'prompt', 'innerWidth',
  'innerHeight', 'addEventListener', 'removeEventListener', 'matchMedia', 'ResizeObserver', 'IntersectionObserver',
  'FormData', 'open', 'scrollTo', 'devicePixelRatio', 'process',
];
const KNOWN = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER]);

function sources(dir) {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return sources(rel);
    return /\.(js|jsx|mjs)$/.test(e.name) ? [rel] : [];
  });
}

test('every name used in the app, API and scripts is declared or imported', () => {
  const missing = [];
  for (const file of ['src', 'server', 'api', 'scripts'].flatMap(sources)) {
    const ast = parse(readFileSync(path.join(ROOT, file), 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    traverse(ast, {
      ReferencedIdentifier(p) {
        const { name } = p.node;
        if (p.isJSXIdentifier() && /^[a-z]/.test(name)) return;
        if (!p.scope.hasBinding(name) && !KNOWN.has(name)) missing.push(`${file}:${p.node.loc.start.line} ${name}`);
      },
    });
  }
  assert.deepEqual(missing, []);
});
