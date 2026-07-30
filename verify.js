/*
 * Headless smoke test: stubs WebGL + WebAudio, runs the payload, drives two
 * frames. No window, no sound. Used by build.js to gate candidates, and as a
 * CLI: node verify.js build/payload.js
 */
const fs = require('fs');
const vm = require('vm');

// real method names, so the demo's x[0]+x[6] aliasing resolves
const GL_METHODS = [
  'createProgram', 'createShader', 'shaderSource', 'compileShader', 'attachShader',
  'linkProgram', 'useProgram', 'enableVertexAttribArray', 'getAttribLocation',
  'vertexAttribPointer', 'bindBuffer', 'createBuffer', 'bufferData', 'uniform1f',
  'uniform2f', 'getUniformLocation', 'drawArrays', 'getShaderParameter',
  'getShaderInfoLog', 'viewport',
];

const REQUIRED_UNIFORMS = ['T', 'R'];

function smokeTest(code) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, args]); return { __loc: name + ':' + args[1] }; };
  let rafCb = null;     // render callback, captured rather than named
  let audioCtx = null;  // to advance the clock between frames

  const gl = {};
  for (const m of GL_METHODS) gl[m] = rec(m);
  gl.getShaderParameter = () => true;
  gl.getShaderInfoLog = () => '';

  const el = (id) => ({
    id, style: {}, width: 0, height: 0,
    remove() { calls.push(['remove', [id]]); },
    getContext: () => gl,
    appendChild() {},
  });

  class FakeAudioContext {
    constructor(opts) {
      calls.push(['AudioContext', [opts]]);
      this.sampleRate = opts && opts.sampleRate;
      this.currentTime = 0;
      this.destination = {};
      audioCtx = this;
    }
    createBuffer(ch, len, sr) {
      calls.push(['createBuffer', [ch, len, sr]]);
      const data = new Float32Array(len);
      // record the copy so we can check it without naming m.o
      const channel = {
        length: len,
        set(src, off) { calls.push(['set', [src && src.length, off]]); return data.set(src, off); },
      };
      return { length: len, getChannelData: () => channel };
    }
    createBufferSource() {
      return {
        buffer: null, loop: false,
        connect() { calls.push(['connect', []]); },
        start() { calls.push(['start', []]); },
      };
    }
  }

  const sandbox = {
    c: el('c'),
    C: el('C'),
    document: { body: { style: {}, appendChild() {} } },
    innerWidth: 1920,
    innerHeight: 1080,
    AudioContext: FakeAudioContext,
    Float32Array, Math, console,
    requestAnimationFrame: (cb) => { rafCb = cb; return 0; },
    performance: { now: () => 0 },
  };
  sandbox.window = sandbox;

  const bad = (m) => { throw new Error(m); };

  vm.runInNewContext(code, sandbox, { filename: 'demo.js', timeout: 20000 });

  // I and A are named in the HTML onclick, so they're a hard contract.
  // Everything else, birb and F included, is free to be renamed.
  if (typeof sandbox.I !== 'function') {
    bad('start function I() was not defined (the HTML onclick calls it by name)');
  }

  const shaderSrc = calls.filter(([n]) => n === 'shaderSource').map(([, a]) => a[1]);
  if (shaderSrc.length !== 2) bad(`expected 2 shaderSource calls, got ${shaderSrc.length}`);
  if (!/#version 300 es/.test(shaderSrc[0])) bad('fragment shader missing #version 300 es (WebGL2/GLSL ES 300)');
  // ES 300 has no gl_FragColor -- it needs a user-declared `out` written to instead
  if (/gl_FragColor/.test(shaderSrc[0])) bad('fragment shader uses gl_FragColor, which does not exist in GLSL ES 300');
  if (!/out\s+vec4\s+\w+;/.test(shaderSrc[0])) bad('fragment shader missing an out vec4 declaration');
  if (/\/\/\*--/.test(shaderSrc[0])) bad('shader fence //*-- survived into the build');
  if (!/gl_Position/.test(shaderSrc[1])) bad('vertex shader missing gl_Position');

  const locs = calls.filter(([n]) => n === 'getUniformLocation').map(([, a]) => a[1]);
  for (const u of REQUIRED_UNIFORMS) {
    if (!locs.includes(u)) bad(`never looked up uniform ${u}`);
  }

  // renders the song, wires audio, draws the first frame
  const beforeStart = calls.length;
  try {
    sandbox.I();
  } catch (e) {
    if (/birb/.test(e.message)) bad(`song.js did not get inlined: ${e.message}`);
    throw e;
  }

  const ac = calls.find(([n]) => n === 'AudioContext');
  if (!ac) bad('no AudioContext created');
  if (!ac[1][0] || ac[1][0].sampleRate !== 44100) {
    bad(`AudioContext sampleRate is ${ac[1][0] && ac[1][0].sampleRate}, birb requires 44100`);
  }

  // checked through observed calls only -- never sandbox.<name>
  const buf = calls.find(([n, a]) => n === 'createBuffer' && a.length === 3);
  if (!buf) bad('never created an AudioBuffer for the song');
  const [, [, bufLen, bufRate]] = buf;
  if (!bufLen) bad('AudioBuffer created with zero length -- birb() returned no samples');
  if (bufRate !== 44100) bad(`AudioBuffer is at ${bufRate}Hz, birb requires 44100`);

  const copied = calls.find(([n]) => n === 'set');
  if (!copied) bad('song samples were never copied into the AudioBuffer');
  if (copied[1][0] !== bufLen) {
    bad(`copied ${copied[1][0]} samples into a ${bufLen}-sample buffer (m.o.length != m.T)`);
  }

  if (!calls.some(([n]) => n === 'connect')) bad('audio source never connected');
  if (!calls.some(([n]) => n === 'start')) bad('audio source never started');

  // I() draws the first frame itself
  const frame = calls.slice(beforeStart);
  if (!frame.some(([n]) => n === 'drawArrays')) bad('first frame did not draw');

  const u2 = frame.find(([n]) => n === 'uniform2f');
  if (!u2) bad('first frame did not set the T uniform');
  if (!Number.isFinite(u2[1][1]) || !Number.isFinite(u2[1][2])) {
    bad(`uniform2f got non-finite values: ${u2[1][1]}, ${u2[1][2]}`);
  }

  // second frame with the clock moved, to catch a stuck uniform
  if (typeof rafCb !== 'function') bad('render loop never scheduled a next frame');
  audioCtx.currentTime = 2.5;
  const beforeSecond = calls.length;
  rafCb(0);
  const second = calls.slice(beforeSecond);
  const u2b = second.find(([n]) => n === 'uniform2f');
  if (!u2b) bad('second frame did not set the T uniform');
  if (!Number.isFinite(u2b[1][1]) || !Number.isFinite(u2b[1][2])) {
    bad(`second frame uniform2f non-finite: ${u2b[1][1]}, ${u2b[1][2]}`);
  }
  if (u2b[1][1] === u2[1][1]) bad('time uniform did not advance when currentTime moved');
  if (u2b[1][2] === u2[1][2]) bad('tick uniform did not advance when currentTime moved');

  return {
    songSeconds: bufLen / 44100,
    samples: bufLen,
    fragBytes: shaderSrc[0].length,
    uniforms: locs,
    frameT: [u2[1][1], u2[1][2]],
    frame2T: [u2b[1][1], u2b[1][2]],
  };
}

/*
 * Compeko eval's the payload from an inline <svg onload> handler, which puts the
 * element in the scope chain. SVGSVGElement has readonly x/y/width/height
 * accessors, so an UNDECLARED variable of that name silently fails to assign.
 * Wrapping in with(fakeSvg) reproduces that, catching it at build time.
 */
const SVG_READONLY = ['x', 'y', 'width', 'height'];

function inSvgHandlerScope(code) {
  const defs = SVG_READONLY
    .map((p) => `Object.defineProperty(__s,'${p}',{get:()=>({baseVal:{value:0}}),configurable:true});`)
    .join('');
  return `var __s={};${defs}with(__s){(function(){eval(${JSON.stringify(code)})})()}`;
}

/** Never throws. Checks both execution contexts the build can emit. */
function trySmokeTest(code) {
  try {
    const info = smokeTest(code);
    try {
      smokeTest(inSvgHandlerScope(code));
    } catch (e) {
      return { ok: false, error: `fails when eval'd from an inline handler (compeko): ${e.message}` };
    }
    return { ok: true, info };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { smokeTest, trySmokeTest, REQUIRED_UNIFORMS };

// ---- CLI ----------------------------------------------------------------
if (require.main === module) {
  const target = process.argv[2] || 'build/payload.js';
  if (!fs.existsSync(target)) {
    console.error(`${target} not found -- run "npm run build" first`);
    process.exit(1);
  }
  const res = trySmokeTest(fs.readFileSync(target, 'utf8'));
  if (!res.ok) {
    console.error(`FAIL: ${res.error}`);
    process.exit(1);
  }
  const i = res.info;
  console.log('PASS');
  console.log(`  song: ${i.songSeconds.toFixed(2)}s (${i.samples} samples)`);
  console.log(`  frag shader: ${i.fragBytes}b`);
  console.log(`  uniforms looked up: ${i.uniforms.join(', ')}`);
  console.log(`  frame 1: T=(${i.frameT[0]}, ${i.frameT[1]})`);
  console.log(`  frame 2: T=(${i.frame2T[0]}, ${i.frame2T[1]}) after clock +2.5s`);
}
