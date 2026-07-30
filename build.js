/*
 * critter build — 4k WebGL demo packer
 * Usage: node build.js demo.html [--fast] [--pack] [--quiet]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const uglifyJS = require('uglify-js');
const { minify_sync } = require('terser');
const zopfli = require('@gfx/zopfli');
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
const COMPEKO = argv.includes('--compeko');
const ZOPFLI_ITER = FAST ? 15 : 1000;   // 2893b floor at 1000; beyond that gains nothing

const log = (...a) => { if (!QUIET) console.log(...a); };
const pct = (n) => `${((n / LIMIT) * 100).toFixed(1)}%`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const payloadTooBig = (s) => s.includes('</script');

/*
 * Compile the shader with glslangValidator if present. Both black screens this
 * project has shipped were minifier output that didn't compile, and neither the
 * smoke test (fake GL context) nor reading it can catch that.
 */
function validateGlsl(src, label) {
  let bin = null;
  for (const c of [process.env.GLSLANG, 'glslangValidator', '/opt/homebrew/bin/glslangValidator']) {
    if (!c) continue;
    try { require('child_process').execFileSync(c, ['-v'], { stdio: 'ignore' }); bin = c; break; } catch { /* next */ }
  }
  if (!bin) return null;

  const f = path.join(BUILD_DIR, 'validate.frag');
  fs.writeFileSync(f, src, 'utf8');
  try {
    require('child_process').execFileSync(bin, ['-S', 'frag', f], { stdio: 'pipe' });
    return true;
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim();
    fail(`${label} shader does not compile:\n${out.split('\n').slice(0, 8).map((l) => '       ' + l).join('\n')}`);
  }
}

const SM_DLL = path.join(__dirname, 'tools/shader-minifier/ShaderMinifier.dll');
// --aggressive-inlining makes the shader ~28b bigger but the final build smaller:
// the repeated inlined constants compress better. Measured, not assumed.
const SM_FLAGS = ['--format', 'text', '--preserve-externals', '--aggressive-inlining'];

/* Shader Minifier needs a .NET 8 runtime; find one or return null. */
function findDotnet() {
  const candidates = [
    process.env.DOTNET,
    '/opt/homebrew/opt/dotnet@8/bin/dotnet',
    '/usr/local/share/dotnet/dotnet',
    'dotnet',
  ].filter(Boolean);
  for (const d of candidates) {
    try {
      require('child_process').execFileSync(d, ['--version'], { stdio: 'ignore' });
      return d;
    } catch { /* keep looking */ }
  }
  return null;
}

/*
 * Shader Minifier (laurentlb, via loertsy's patched build) if available,
 * otherwise webpack-glsl-minify with renaming disabled.
 *
 * webpack-glsl-minify's renamer is unsafe: it renames struct member
 * declarations but not every usage, and will give a function the same name as
 * an existing uniform. Both yield a shader that silently fails to compile, so
 * the fallback keeps every name -- costing ~850b.
 */
async function minifyShader(shader, log) {
  const src = path.join(BUILD_DIR, 'shader.glsl');
  const out = path.join(BUILD_DIR, 'shader.min.glsl');
  fs.writeFileSync(src, shader, 'utf8');
  fs.rmSync(out, { force: true });   // never read a stale result

  const dotnet = fs.existsSync(SM_DLL) ? findDotnet() : null;
  if (dotnet) {
    await execFile(dotnet, [SM_DLL, '-o', out, ...SM_FLAGS, src], { cwd: __dirname });
    if (!fs.existsSync(out)) fail('Shader Minifier produced no output');
    const min = fs.readFileSync(out, 'utf8').trim();
    if (!min) fail('Shader Minifier produced an empty file');
    return { code: min, tool: 'shader-minifier' };
  }

  const legacy = src + 'min';
  fs.rmSync(legacy, { force: true });
  await execFile('npx', [
    'webpack-glsl-minify', src, '--output', 'sourceOnly',
    '--preserveUniforms', '--preserveVariables', '--preserveDefines', '-e', 'min',
  ], { cwd: __dirname });
  // exits 0 writing nothing when it can't read the input, so don't trust the code
  if (!fs.existsSync(legacy)) fail(`shader minifier produced no output at ${legacy}`);
  const min = fs.readFileSync(legacy, 'utf8').trim();
  if (!min) fail('shader minifier produced an empty file');
  log('  ! Shader Minifier unavailable (needs .NET 8) -- falling back, costs ~850b');
  return { code: min, tool: 'webpack-glsl-minify' };
}

/*
 * Compeko (after 0b5vr, via gitlab.com/bits_lab/loertsy): append a raw deflate
 * stream after the markup and let the browser's native DecompressionStream
 * inflate it. fetch`#` re-fetches the page and slices the header off, so the
 * payload needs no escaping and costs no decompressor.
 *
 * Caveat: fetch on file:// is cross-origin in Chromium, so the result needs
 * `--allow-file-access-from-files` or to be served over HTTP. Firefox is fine.
 */
async function compeko(markup, js) {
  const jsLen = Buffer.byteLength(js, 'utf8');
  const pre = '<svg onload="fetch`#`.then(r=>r.blob()).then(b=>new Response(b.slice(';
  const mid = ").stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()).then(G=>eval(new TextDecoder().decode(G.slice(0,W=";
  const post = '))))">';

  // header length appears inside the header, so solve for it
  let len = 0, header = '';
  for (let i = 0; i < 8; i++) {
    header = markup + pre + len + mid + jsLen + post;
    const n = Buffer.byteLength(header, 'utf8');
    if (n === len) break;
    len = n;
  }
  if (Buffer.byteLength(header, 'utf8') !== len) fail('compeko header length did not converge');

  const data = await zopfli.deflateAsync(Buffer.from(js, 'utf8'), { numiterations: ZOPFLI_ITER });
  return { html: Buffer.concat([Buffer.from(header, 'utf8'), data]), headerLen: len, dataLen: data.length };
}

/* inflate an emitted compeko file the same way the browser will, and run it */
async function checkCompeko(buf, headerLen, jsLen) {
  const stream = new Blob([buf]).slice(headerLen).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const G = await new Response(stream).arrayBuffer();
  const js = new TextDecoder().decode(G.slice(0, jsLen));
  return { js, ...trySmokeTest(js) };
}

async function main() {
  if (!htmlFilePath) fail('pass the HTML file path, e.g. node build.js demo.html');
  if (!fs.existsSync(htmlFilePath)) fail(`${htmlFilePath} does not exist`);

  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // clear last run's artifacts so a failed build can't leave verify.js a stale
  // payload to pass against
  for (const f of ['payload.js', 'minified.js']) fs.rmSync(path.join(BUILD_DIR, f), { force: true });

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

      // catch a malformed export here rather than as four confusing minifier
      // failures further down
      try {
        new vm.Script(code, { filename: src[1] });
      } catch (e) {
        fail(`${src[1]} is not valid JavaScript: ${e.message}\n` +
             `       re-export from the tracker; the packed export embeds raw\n` +
             `       control bytes in a quoted string, which cannot parse`);
      }

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

  // #version 300 es lives outside the //*-- fence in demo.html (real WebGL2
  // requires it as the literal first line, before even a comment -- the
  // fence marker itself would violate that in dev mode). Both validators
  // below still need it in scope to know this is ES 300 (without it,
  // glslangValidator assumes an old default version and rejects the
  // fragment shader's `out` declaration), so prepend it here and strip it
  // back off before splicing the minified result back into the fence.
  const VERSION_RE = /^#version\s+300\s+es\s*\n/;
  shader = '#version 300 es\n' + shader;

  // validate before and after: "before" blames your source, "after" blames the minifier
  const preOk = validateGlsl(shader, 'source');
  const sm = await minifyShader(shader, log);
  validateGlsl(sm.code, `minified (${sm.tool})`);
  log(preOk === null ? '  ! glslangValidator not found -- shader not compile-checked' : '  shader compiles (glslang)');
  let shaderMin = sm.code;
  if (!VERSION_RE.test(shaderMin)) {
    fail(`minifier (${sm.tool}) did not keep #version 300 es as the shader's first line -- can't safely split it back out`);
  }
  shaderMin = shaderMin.replace(VERSION_RE, '');
  if (usesW) shaderMin = shaderMin.replaceAll(W_TOKEN, '${w}');
  if (usesH) shaderMin = shaderMin.replaceAll(H_TOKEN, '${h}');
  log(`  shader minified ${shader.length}b -> ${shaderMin.length}b (${sm.tool})`);

  if (shaderMin.includes('`')) fail('minified shader contains a backtick; it would break the template literal');

  // A renamed uniform is a silent black screen. Shader Minifier merges
  // declarations (`uniform vec2 T,R;`), so match the name anywhere in one.
  for (const u of REQUIRED_UNIFORMS) {
    const declared = [...shaderMin.matchAll(/uniform\s+\w+\s+([^;]+);/g)]
      .some((m) => m[1].split(',').some((n) => n.trim().replace(/\[.*/, '') === u));
    if (!declared) {
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

  const markup = strippedHtml.trim();

  // ---- 6. size both backends per candidate ------------------------------
  for (const c of candidates) {
    if (payloadTooBig(c.payload)) fail('payload contains "</script"; it would terminate the tag early');
    c.rrTotal = Buffer.byteLength(markup + '<script>' + c.payload + '</script>', 'utf8');
    const ck = await compeko(markup, c.code);
    c.compeko = ck;
    c.ckTotal = ck.html.length;
    log(`  ${c.tool.padEnd(14)} roadroller ${String(c.rrTotal).padStart(5)}b   compeko ${String(c.ckTotal).padStart(5)}b`);
  }

  const pick = (key) => candidates.reduce((a, b) => (a[key] <= b[key] ? a : b));
  const bestRR = pick('rrTotal');
  const bestCK = pick('ckTotal');

  const outPath = path.resolve(__dirname, `${name}-build.html`);
  let final, chosen, label;

  if (COMPEKO) {
    chosen = bestCK;
    final = chosen.compeko.html;
    label = `${chosen.tool}, compeko+zopfli`;
    // prove the emitted file inflates and still runs
    const res = await checkCompeko(final, chosen.compeko.headerLen, Buffer.byteLength(chosen.code, 'utf8'));
    if (!res.ok) fail(`compeko output does not run: ${res.error}`);
    if (res.js !== chosen.code) fail('compeko round-trip did not reproduce the payload');
    log(`  compeko verified: header ${chosen.compeko.headerLen}b + deflate ${chosen.compeko.dataLen}b (zopfli i=${ZOPFLI_ITER})`);
  } else {
    chosen = bestRR;
    final = Buffer.from(markup + '<script>' + chosen.payload + '</script>', 'utf8');
    label = `${chosen.tool}, ${chosen.usePacked ? 'roadroller' : 'unpacked'}`;
  }

  fs.writeFileSync(path.join(BUILD_DIR, 'minified.js'), chosen.code, 'utf8');
  fs.writeFileSync(path.join(BUILD_DIR, 'payload.js'), chosen.payload, 'utf8');
  fs.writeFileSync(outPath, final);

  const bytes = final.length;
  const left = LIMIT - bytes;
  console.log(`\n${outPath}  [${label}]`);
  console.log(`${bytes} bytes / ${LIMIT}  (${pct(bytes)})  ${left >= 0 ? `${left} to spare` : `OVER by ${-left}`}`);
  const other = COMPEKO
    ? `roadroller would be ${bestRR.rrTotal} (${bestRR.tool})`
    : `compeko+zopfli would be ${bestCK.ckTotal} (${bestCK.tool}) -- ${bestRR.rrTotal - bestCK.ckTotal}b smaller, needs HTTP or Chrome --allow-file-access-from-files`;
  console.log(other);
  if (left < 0) process.exitCode = 1;
}

main().catch((e) => fail(e.stack || String(e)));
