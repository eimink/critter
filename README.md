# critter

4k WebGL demo framework. Shader in, [birb](https://github.com/eimink/birb) song in,
single self-contained HTML under 4096 bytes out.

Structurally based on [process-stutterjump](https://github.com/sevendc/process-stutterjump),
with SoundBox swapped for birb and the build rewritten.

## Use

```bash
npm install
npm run check     # fast build + smoke test
npm run build     # full build (slow Roadroller search)
```

1. Compose in the birb tracker, **Export .js**, save over `song.js`.
2. Write your shader in `demo.html` between the `//*--` fences.
3. `npm run check` to iterate, `npm run build` to ship.

Use the plain **Export .js**, not the packed one — that form is
near-incompressible and Roadroller does better with readable JS. The build warns
if it sees it.

## Shader

Lives in a template literal fenced by `//*--`, which is a GLSL line comment, so it
compiles unmodified during dev. Uniforms:

| | |
|---|---|
| `T.x` | seconds since start |
| `T.y` | birb tick, from `m.spt` — beat sync |
| `R` | resolution |

Both are `vec2` on purpose: one location lookup and one `uniform2f` per frame
instead of four. If you add a uniform looked up by name, add it to
`REQUIRED_UNIFORMS` in `build.js` — the build then fails loudly instead of handing
you a black screen when the minifier renames it.

Code between `// -- dev start` / `// -- dev end` is stripped from the build.

## Music

Per birb's `INTEGRATION.md`: `birb(ctx)` renders the song offline and returns
`{o, T, spt}`. critter calls it on click (browsers block audio before a gesture)
and syncs off `ctx.currentTime`. Requires a 44100 Hz context.

## Flags

| | |
|---|---|
| *(none)* | full Roadroller search — slow, smallest |
| `--fast` | skip the search |
| `--pack` | ship packed even when larger |
| `--quiet` | final size only |

## How the winner is picked

Four candidates — `terser`, `terser+mangle`, `uglify`, `uglify+mangle` — each
gated on passing the smoke test, then each packed, and selected on **final shipped
size**. Mangling is therefore safe to attempt: a variant that breaks the demo is
rejected, not shipped.

Selection is on packed size because ranking by minified size picks wrong:

```
terser   1644b -> packed 1891b     <- wins packed
uglify   1641b -> packed 1895b     <- wins minified
```

**Roadroller isn't always a win.** Its decoder is fixed overhead a small payload
can't amortise, so each candidate ships packed or unpacked, whichever is smaller.

**uglify needs `module: false`.** Its `minify()` defaults `module: true`
(`lib/minify.js:108`), which implies strict, and strict rejects `with`. The parser
itself is fine with it.

## `with(g)` vs mangling — measured

`with` disables mangling file-wide, which looks like it costs bytes. It doesn't.
Same demo, placeholder song, final size:

| variant | winner | final |
|---|---|---|
| `with(g)`, hand-golfed *(current)* | uglify, no mangle | **1720 b** |
| no `with`, hand-golfed | uglify+mangle | 1725 b |
| no `with`, declared + readable names | uglify+mangle | 1792 b |

Dropping `with` costs 11 b of plumbing (`.call&&` to skip non-function props,
`.bind(g)` per alias, a separate `uniform2f` alias since it collides with
`uniform1f` under `x[0]+x[6]`). Mangling recovers 6.

The readable variant loses by 72 b even though mangling saves 545 b *within* it:
the toplevel vars are undeclared implicit globals, which cost nothing to
introduce. Declaring them to make them manglable adds a `var a,b,c,…` list that
implicit globals never pay. A mangler shortens names; it can't delete
declarations.

The matrix still tries all four every build, so restructuring away from `with`
gets picked up automatically.

## verify.js

Stubs WebGL and WebAudio, runs the payload, drives two frames. No window, no
sound. Catches: `song.js` not inlined, the fence surviving, an unused uniform,
wrong sample rate, sample count not matching buffer length, `NaN` in a uniform,
and a clock that doesn't advance.

Assertions are **name-independent** — the build may rename anything except `I` and
`A` (the HTML `onclick` names them). An earlier version asserted on `birb`, `m`
and `F` and rejected three working builds. Assert on observed calls, never
`sandbox.<name>`.

```bash
node verify.js build/payload.js
```

## Differences from stutterjump

- **Inlines `<script src>`.** stutterjump collects only inline scripts, so an
  external `song.js` is dropped silently — shader works, no music, no error.
- **Fixed uglify** via `module: false`; stutterjump's call errors, then reads
  `.code` off the error and takes `.length` of `undefined`.
- **Selects on packed size** across a gated matrix.
- `replaceAll` for `${w}`/`${h}`; `.replace()` does only the first.
- **Explicit shader splice.** stutterjump substitutes into `` `/` ``, the residue
  of the template literal after deleting the fenced block — breaks silently if you
  touch the fence.
- Dropped the SoundBox song-key renames (blind whole-source string replacements).
- Guards where tools fail silently: the GLSL minifier exits 0 writing nothing.
- Node 24, not 18.

## Node version

stutterjump's `"node": ">=18.0.0 <19.0.0"` pin is load-bearing: `roadroller@2.1.0`'s
`index.cjs` loads the abandoned `esm` shim, which crashes on modern Node. critter
imports `index.mjs` (native ESM) via dynamic `import()` instead.
`webpack-glsl-minify` also depends on `esm`, but only in its CLI, which runs as a
subprocess.

## Tools

[Roadroller](https://github.com/lifthrasiir/roadroller) ·
[terser](https://terser.org/) ·
[uglify-js](https://github.com/mishoo/UglifyJS) ·
[webpack-glsl-minify](https://www.npmjs.com/package/webpack-glsl-minify) (unmaintained since 2022, works) ·
[birb](https://github.com/eimink/birb)
