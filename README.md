# critter

4k WebGL demo framework. Shader in, [birb](https://github.com/eimink/birb) song in,
single self-contained HTML under 4096 bytes out.

Structure follows [process-stutterjump](https://github.com/sevendc/process-stutterjump);
the compression backends follow [loertsy](https://gitlab.com/bits_lab/loertsy).

## Use

```bash
npm install
npm run check                 # fast build + smoke test
npm run build                 # roadroller backend
npm run build -- --compeko    # compeko + zopfli backend
```

1. Compose in the birb tracker, **Export .js**, save over `song.js`.
2. Write your shader in `demo.html` between the `//*--` fences.
3. `npm run check` to iterate, a full build for any size decision.

## Choosing a backend

Two ways to get under 4096, and which wins depends on your payload. **Every build
sizes both and reports the one you didn't pick**, so a single build gives you the delta:

```
3017 bytes / 4096  (73.7%)  1079 to spare
roadroller would be 3923 (terser)
```

| | how it works | cost | constraint |
|---|---|---|---|
| **roadroller** (default) | context-mixing packer, self-extracting JS | ~500 b decoder, output is text | none — runs from `file://` anywhere |
| **compeko + zopfli** (`--compeko`) | raw deflate appended after the markup, inflated by the browser's `DecompressionStream` | 273 b bootstrap, zero escaping | `fetch("#")` is cross-origin on `file://` in Chromium |

Compeko is ~900 b smaller on a payload this size, because its bootstrap is tiny and
the deflate stream needs no text encoding. Roadroller compresses better per byte but
pays for its decoder twice — once in code, once in representing binary as JS source.

**Both currently fit** (3017 and 3921), so this is a portability choice, not a size one:
pick roadroller if the intro must run by double-clicking in Chrome, otherwise compeko
for the extra headroom.

Within each backend the build tries four minifiers (`terser`, `uglify`, and both
`+mangle`), gates each on the smoke test, and picks the smallest **final** size. Rank
by minified size and you choose wrong — the backends routinely prefer different ones.

### Flags

| | |
|---|---|
| *(none)* | full roadroller parameter search |
| `--compeko` | compeko + zopfli backend |
| `--fast` | skip the search — iteration only, never for size decisions |
| `--pack` | ship roadroller output even when larger (comparison) |
| `--quiet` | final size only |

`--fast` costs roadroller ~200 b but zopfli only 1 b (i=15 → 2894, i=1000 → 2893),
so compeko builds are effectively always full quality.

## Shader

Lives in a template literal fenced by `//*--`, which is a GLSL line comment, so it
compiles unmodified during dev. `T.x` = seconds, `T.y` = birb tick (beat sync),
`R` = resolution. Both `vec2` deliberately: one lookup and one `uniform2f` per frame.
`Q` in the JS is the render scale — `Q=2` renders quarter the pixels and lets CSS upscale.

Add a uniform looked up by name and add it to `REQUIRED_UNIFORMS` in `build.js`, or a
rename becomes a silent black screen.

Code between `// -- dev start` / `// -- dev end` is stripped from the build.

### Shader Minifier (optional, worth ~850 b)

`tools/shader-minifier/` is [Shader Minifier](https://github.com/laurentlb/shader-minifier)
1.5.1 — loertsy's patched build. It does real scope analysis: overloads functions by
signature, and shadows uniform names only where the uniform isn't live. On this demo it
gets the shader to 1941 b where `webpack-glsl-minify` (with renaming disabled) manages
2766 b. **That 850 b is the difference between roadroller fitting and not.**

**It needs a .NET 8 runtime.** `brew install dotnet@8` (~510 MB, keg-only). The build
probes `$DOTNET`, `/opt/homebrew/opt/dotnet@8/bin/dotnet`, `/usr/local/share/dotnet/dotnet`,
then `dotnet` on PATH. Without one it falls back to `webpack-glsl-minify` and says so —
builds still work, just larger. Upstream ships only a Windows `.exe`, which is why the
DLLs are vendored here.

Flags are `--preserve-externals --aggressive-inlining`. The second makes the shader ~28 b
*bigger* and the final build ~10 b smaller, because repeated inlined constants compress
better — measured on final size, which is the only metric that matters.

Constraints and known bugs in 1.5.1:

- **Avoid structs.** It will rename a struct's *type* to a name it also gives a local
  variable — `struct C{...}` plus `float …,C=sin(x);` — which doesn't compile. This shipped
  as a black screen. `march` returns `vec2` with an `out` param instead of a struct.
- **No struct field named `x/y/z/w`, `r/g/b/a` or `s/t/p/q`** — it can't safely rename a
  field that looks like a swizzle, and errors out (this one it catches).
- Parse errors point at a line number in `build/shader.glsl`, the exact text it was given.

Because both hazards produce a shader that *compiles nowhere*, the build runs
`glslangValidator` on the shader before and after minification and fails on error —
"before" blames your source, "after" blames the minifier. `brew install glslang`; without
it the build warns and skips the check. The smoke test cannot substitute: its fake GL
context always reports `COMPILE_STATUS: true`.

Redistribution terms for the vendored binaries (Apache-2.0, MIT, BSD-2-Clause) are in
[`tools/shader-minifier/THIRD-PARTY-NOTICES`](tools/shader-minifier/THIRD-PARTY-NOTICES).

## Music

`birb(ctx)` renders offline and returns `{o, T, spt}`; critter calls it on click
(browsers block audio before a gesture) and syncs off `ctx.currentTime`. Requires a
44100 Hz context. See birb's `INTEGRATION.md`.

## Edge cases

Each of these was hit for real, and most fail *silently*.

**Compression**

- **Roadroller output is not reproducible.** Identical input gave 4056/4045/4039/4045 —
  a 17 b spread, and the winning minifier changes between runs. Near the limit, build
  several times and trust the worst. Keep a build you like; you can't regenerate it.
- **Roadroller inflates small payloads.** Below ~2 KB its decoder costs more than it
  saves, so each candidate ships packed or unpacked, whichever is smaller.
- **Never pre-compress upstream of either backend.** The tracker's packed `.js` export
  is 2 KB smaller going in and ~640 b *larger* coming out — it destroys the redundancy
  the compressor needs. Palette-encoding the song's note tables saved 1144 b of source
  and changed the final build by 6 b (noise). Emit readable JS and let the packer work.
- **Gating unused synth features is the one thing that reliably pays.** Removing a
  reverb that every send set to zero cut 232 real bytes.

**Things that silently break**

- **`webpack-glsl-minify`'s renamer is unsafe.** It renames struct member declarations
  but not all usages, and will name a function the same as an existing uniform. Either
  produces a shader that fails to compile — a black screen with working audio, because
  the dev-block `alert` is stripped from the build. Renaming is therefore disabled in the
  fallback path. Use Shader Minifier instead (see above).
- **Undeclared globals collide with DOM properties under `--compeko`.** The payload is
  eval'd from an inline `<svg onload>`, putting the element in the scope chain.
  `SVGSVGElement` has readonly `x`/`y`/`width`/`height`, so an undeclared `x` never
  assigns and fails silently. Declare loop variables (`for(let x in …)`).
- **`uglify` needs `module: false`.** Its default `module: true` implies strict, and
  strict rejects `with`. The parser is fine with it.
- **`with(g)` disables mangling file-wide** — but hand-golfed implicit globals already
  beat what mangling could recover, and declaring them to enable it costs more than it
  saves. Measured: keeping `with(g)` wins.
- **Three comment forms are load-bearing:** `//*--` (build fails without it) and
  `// -- dev start` / `// -- dev end` (drop the markers and dev code ships, +103 b).
  Every other comment is free — stripping all 300 b of them gives a byte-identical build.

## verify.js

Stubs WebGL and WebAudio, runs the payload, drives two frames. No window, no sound.
Serves as both a CLI check and the build's gate for minifier candidates.

```bash
node verify.js build/payload.js
```

Catches: `song.js` not inlined, the fence surviving, an unused uniform, wrong sample
rate, sample count not matching buffer length, `NaN` in a uniform, a clock that doesn't
advance, and code that breaks when eval'd from an inline handler.

Two rules if you extend it:

- **Assert on observed calls, never `sandbox.<name>`.** The build may rename anything
  except `I` and `A` (named in the HTML `onclick`). An earlier version asserted on
  `birb`, `m` and `F` and rejected three working builds.
- **It is not a browser.** Its fake GL context can't catch a shader that fails to
  compile, and its mock puts methods on the object rather than a prototype. Test in a
  browser before trusting a build.

## Node and deps

Runs on Node 24. stutterjump's `"node": ">=18 <19"` pin is load-bearing —
`roadroller@2.1.0`'s `index.cjs` loads the abandoned `esm` shim, which crashes on modern
Node; critter imports `index.mjs` via dynamic `import()` instead.

zopfli is `@gfx/zopfli` (WASM, no native build), verified byte-identical to the zopfli
CLI. Homebrew's `zopfli` is deprecated — don't depend on it.

[roadroller](https://github.com/lifthrasiir/roadroller) ·
[terser](https://terser.org/) ·
[uglify-js](https://github.com/mishoo/UglifyJS) ·
[webpack-glsl-minify](https://www.npmjs.com/package/webpack-glsl-minify) (unmaintained) ·
[birb](https://github.com/eimink/birb)
