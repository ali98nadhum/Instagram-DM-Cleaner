import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const srcPath = path.join(root, 'dist', 'content.js');
const outPath = path.join(root, 'userscript', 'instagram-message-cleaner.user.js');

if (!fs.existsSync(srcPath)) {
  console.error(`Missing ${path.relative(root, srcPath)} — run "npm run build" (which runs tsc first), not this script directly.`);
  process.exit(1);
}

const header = `// ==UserScript==
// @name         Instagram Message Cleaner
// @namespace    instagram-message-cleaner.local
// @version      1.0.1
// @description  Bulk-unsend your own messages from an Instagram DM conversation. Runs fully in your browser, uses your existing Instagram session, never touches your password or sends data anywhere else.
// @author       you
// @match        https://www.instagram.com/direct/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

`;

const body = fs.readFileSync(srcPath, 'utf8');
fs.writeFileSync(outPath, header + body);
console.log(`Wrote ${path.relative(root, outPath)}`);
