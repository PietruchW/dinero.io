import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { APP_VERSION } from '../src/config.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('wersja aplikacji zgadza się z pamięcią podręczną service workera', () => {
  assert.match(read('sw.js'), new RegExp(`const CACHE = 'dinero-shell-v${APP_VERSION}';`));
});

test('każdy plik aplikacji jest na liście SHELL service workera', () => {
  const sw = read('sw.js');
  const files = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 9);
  for (const file of files) assert.ok(sw.includes(`'./src/${file}'`), `brak src/${file} w SHELL w sw.js`);
});
