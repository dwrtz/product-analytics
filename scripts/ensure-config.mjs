// Creates wrangler.jsonc from wrangler.example.jsonc on first run (wrangler.jsonc is git-ignored: it holds your ids and vars).
import fs from 'node:fs';
if (!fs.existsSync('wrangler.jsonc')) { fs.copyFileSync('wrangler.example.jsonc', 'wrangler.jsonc'); console.log('created wrangler.jsonc from wrangler.example.jsonc'); }
