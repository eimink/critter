/*
 * critter build — 4k WebGL demo packer
 * Usage: node build.js demo.html [--fast] [--pack] [--quiet]
 */
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const uglifyJS = require('uglify-js');
const { minify_sync } = require('terser');
const { trySmokeTest } = require('./verify');

// roadroller's index.cjs loads the abandoned `esm` shim, broken on modern Node
// (hence stutterjump's node 18 pin). index.mjs is native ESM.
const loadRoadroller = () => import('roadroller');

const LIMIT = 4096;
const BUILD_DIR = path.resolve(__dirname, 'build');
const REQUIRED_UNIFORMS = ['T', 'R'];   // looked up by string, must survive minify
const RESERVED = ['I', 'A'];            // named in the HTML onclick

const argv = process.argv.slice(2);
const htmlFilePath = argv.find((a) => !a.startsWith('--'));
const FAST = argv.includes('--fast');
const QUIET = argv.includes('--quiet');
const FORCE_PACK = argv.includes('--pack');

const log = (...a) => { if (!QUIET) console.log(...a); };
const pct = (n) => `${((n / LIMIT) * 100).toFixed(1)}%`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function main() {
  if (!htmlFilePath) fail('pass the HTML file path, e.g. node build.js demo.html');
  if (!fs.existsSync(htmlFilePath)) fail(`${htmlFilePath} does not exist`);

  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const name = path.basename(htmlFilePath).replace(/\.html?$/i, '');
  const htmlDir = path.dirname(path.resolve(htmlFilePath));
  const htmlContent = fs.readFileSync(htmlFilePath, 'utf8');
  log(`building ${name}  (html ${htmlContent.length}b)`);

  // ---- 1. collect scripts, inlining src= files ----------------------------
  // Document order, so song.js lands before the code calling birb(). One stream
  // means the synth and demo share Roadroller's compression context.
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const parts = [];

  const strippedHtml = htmlContent.replace(scriptRegex, (match, attrs, inline) => {
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (src) {
      const p = path.resolve(htmlDir, src[1]);
      if (!fs.existsSync(p)) {
        fail(`<script src="${src[1]}"> not found at ${p}\n` +
             `       export a song from the birb tracker ("Export .js") and save it there`);
      }
      const code = fs.readFileSync(p, 'utf8');
      log(`  inlined ${src[1]}  ${code.length}b`);

      // the tracker's packed export is near-incompressible; Roadroller prefers
      // the readable one
      if (/eval\(_\)/.test(code) || /\.split\('\|'\)\.reverse\(\)/.test(code)) {
        log(`  ! ${src[1]} looks like the packed export; plain "Export .js" packs better`);
      }
      parts.push(code.trim());
      return '';
    }
    parts.push(inline.trim());
    return '';
  });

  if (!parts.length) fail('no <script> found in the HTML');
  let script = parts.join('\n');

  // ---- 2. strip dev blocks ------------------------------------------------
  const devBlockRegex = /\/\/\s*--\s*dev\s*start[\s\S]*?\/\/\s*--\s*dev\s*end\s*(\r?\n)?/gi;
  const devBlocks = script.match(devBlockRegex);
  log(`  stripped ${devBlocks ? devBlocks.length : 0} dev block(s)`);
  script = script.replace(devBlockRegex, '');

  // ---- 3. shader ----------------------------------------------------------
  // //*-- fences both ends; it's a GLSL line comment, so dev builds compile as-is
  const shaderRegex = /\/\/\*--([\s\S]*?)\/\/\*--/g;
  const found = [...script.matchAll(shaderRegex)];
  if (!found.length) fail('no //*-- fenced shader block found');
  if (found.length > 1) fail(`found ${found.length} shader blocks; expected 1`);

  let shader = found[0][1].trim();
  log(`  shader ${shader.length}b`);

  // swap template-literal holes for numbers the GLSL minifier can parse
  const W_TOKEN = '436.0', H_TOKEN = '258.0';
  const usesW = shader.includes('${w}'), usesH = shader.includes('${h}');
  shader = shader.replaceAll('${w}', W_TOKEN).replaceAll('${h}', H_TOKEN);

  const glslPath = path.join(BUILD_DIR, 'shader.glsl');
  const glslMinPath = glslPath + 'min';
  fs.writeFileSync(glslPath, shader, 'utf8');
  fs.rmSync(glslMinPath, { force: true });   // never read a stale result

  // uniforms must keep their names; locals should be mangled
  await execFile('npx', [
    'webpack-glsl-minify', glslPath,
    '--output', 'sourceOnly',
    '--preserveUniforms',
    '-e', 'min',
  ], { cwd: __dirname });

  // exits 0 writing nothing when it can't read the input, so don't trust the code
  if (!fs.existsSync(glslMinPath)) fail(`shader minifier produced no output at ${glslMinPath}`);
  let shaderMin = fs.readFileSync(glslMinPath, 'utf8').trim();
  if (!shaderMin) fail('shader minifier produced an empty file');
  if (usesW) shaderMin = shaderMin.replaceAll(W_TOKEN, '${w}');
  if (usesH) shaderMin = shaderMin.replaceAll(H_TOKEN, '${h}');
  log(`  shader minified ${shader.length}b -> ${shaderMin.length}b`);

  if (shaderMin.includes('`')) fail('minified shader contains a backtick; it would break the template literal');

  // a renamed uniform is a silent black screen
  for (const u of REQUIRED_UNIFORMS) {
    if (!new RegExp(`uniform\\s+\\w+\\s+${u}\\b`).test(shaderMin)) {
      fail(`uniform "${u}" is missing from the minified shader -- the JS looks it up by name`);
    }
  }

  script = script.replace(shaderRegex, () => shaderMin);

  // ---- 4. minify: try a matrix, keep the variants that still run ----------
  // uglify needs module:false; its default module:true implies strict, and
  // strict rejects `with`. The parser itself is fine with it.
  const terserBase = { compress: { drop_console: true, passes: 25, ecma: 2020, hoist_funs: true, unsafe: true } };
  const mangleAll = { toplevel: true, reserved: RESERVED };

  const variants = [
    { tool: 'terser', run: () => minify_sync(script, { ...terserBase, mangle: { reserved: RESERVED } }) },
    { tool: 'terser+mangle', run: () => minify_sync(script, { ...terserBase, mangle: mangleAll }) },
    { tool: 'uglify', run: () => uglifyJS.minify(script, { module: false, mangle: { reserved: RESERVED } }) },
    { tool: 'uglify+mangle', run: () => uglifyJS.minify(script, { module: false, mangle: mangleAll }) },
  ];

  const candidates = [];
  for (const v of variants) {
    let out;
    try { out = v.run(); } catch (e) { out = { error: e }; }
    if (out.error || !out.code) {
      log(`  ${v.tool.padEnd(14)} minify failed: ${(out.error && out.error.message) || 'no output'}`);
      continue;
    }
    // mangling can rename something with(g) made ambiguous, so prove it runs
    const check = trySmokeTest(out.code);
    if (!check.ok) {
      log(`  ${v.tool.padEnd(14)} ${String(out.code.length).padStart(5)}b  REJECTED: ${check.error}`);
      continue;
    }
    candidates.push({ tool: v.tool, code: out.code });
    log(`  ${v.tool.padEnd(14)} ${String(out.code.length).padStart(5)}b  runs ok`);
  }

  if (!candidates.length) fail('every minifier variant failed or broke the demo');

  // ---- 5. pack each survivor, pick the smallest final --------------------
  // Selection is on packed size: Roadroller models context, so a longer but
  // more repetitive input can win.
  const { Packer } = await loadRoadroller();
  if (!FAST) log(`  optimizing Roadroller parameters for ${candidates.length} candidate(s) (slow; --fast to skip)...`);

  for (const c of candidates) {
    const packer = new Packer([{ data: c.code, type: 'js', action: 'eval' }], { maxMemoryMB: 512 });
    if (!FAST) await packer.optimize();
    const { firstLine, secondLine } = packer.makeDecoder();
    c.packed = firstLine + secondLine;
    // the decoder is fixed overhead a small payload can't amortise
    c.usePacked = FORCE_PACK || c.packed.length < c.code.length;
    c.payload = c.usePacked ? c.packed : c.code;
    log(`  ${c.tool.padEnd(14)} ${String(c.code.length).padStart(5)}b -> packed ${String(c.packed.length).padStart(5)}b` +
        `  ship ${String(c.payload.length).padStart(5)}b [${c.usePacked ? 'roadroller' : 'unpacked'}]`);
  }

  const best = candidates.reduce((a, b) => (a.payload.length <= b.payload.length ? a : b));
  const { payload, usePacked } = best;
  log(`  winner: ${best.tool} [${usePacked ? 'roadroller' : 'unpacked'}]`);

  fs.writeFileSync(path.join(BUILD_DIR, 'minified.js'), best.code, 'utf8');
  fs.writeFileSync(path.join(BUILD_DIR, 'payload.js'), payload, 'utf8');

  if (payload.includes('</script')) fail('payload contains "</script"; it would terminate the tag early');

  const final = strippedHtml.trim() + '<script>' + payload + '</script>';
  const outPath = path.resolve(__dirname, `${name}-build.html`);
  fs.writeFileSync(outPath, final, 'utf8');

  const bytes = Buffer.byteLength(final, 'utf8');
  const left = LIMIT - bytes;
  console.log(`\n${outPath}  [${best.tool}, ${usePacked ? 'roadroller' : 'unpacked'}]`);
  console.log(`${bytes} bytes / ${LIMIT}  (${pct(bytes)})  ${left >= 0 ? `${left} to spare` : `OVER by ${-left}`}`);
  if (left < 0) process.exitCode = 1;
}

main().catch((e) => fail(e.stack || String(e)));
