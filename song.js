/*
 * PLACEHOLDER — replace with your birb tracker "Export .js".
 * Prefer the plain export over the packed one; Roadroller compresses it better.
 * Contract: birb(ctx) -> { o: Float32Array, T: sample count, spt: samples/tick }
 */
function birb(X) {
    var SR = 44100, spt = SR / 8, T = SR * 4,
        o = new Float32Array(T);
    for (var i = 0; i < T; i++) {
        var step = (i / spt) | 0,
            env = Math.exp(-(i % spt) / (spt * 0.3));
        o[i] = Math.sin(i * 0.05 * (1 + (step % 4) * 0.25)) * env * 0.3;
    }
    return { o: o, T: T, spt: spt };
}
