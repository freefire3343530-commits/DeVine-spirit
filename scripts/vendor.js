// Self-host Three.js (run after `npm install`): copies the pinned build into web/vendor and points the import map at it.
import fs from 'node:fs';
const src = 'node_modules/three/build/three.module.js';
if (!fs.existsSync(src)) { console.error('Run `npm install` first.'); process.exit(1); }
fs.mkdirSync('web/vendor', { recursive: true }); fs.copyFileSync(src, 'web/vendor/three.module.js');
const f = 'web/index.html', html = fs.readFileSync(f, 'utf8').replace(/"three":"[^"]+"/, '"three":"./vendor/three.module.js"');
fs.writeFileSync(f, html); console.log('Three.js vendored; import map now local.');
