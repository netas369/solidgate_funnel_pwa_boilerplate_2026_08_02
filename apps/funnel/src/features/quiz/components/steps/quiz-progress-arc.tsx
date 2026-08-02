'use client';

// Progress footer for question screens: a shallow dome arc with a glowing trail
// and a marker that travels left→right as the quiz advances. `progress` is 0..1
// (current step position / total). Drawn with SVG so the trail + marker position
// are fully dynamic for any number of questions.

const ARC_PATH = 'M0 60 Q187.5 -12 375 60';

// Cumulative arc-length fractions of the quadratic arc, sampled once. The
// dash trail is measured along the curved path while the marker is placed by
// x — this table converts between the two so the trail ends exactly at the
// marker instead of overshooting it on the steeper first half.
const ARC_LENGTH_FRACS = (() => {
  const N = 64;
  const y = (t: number) => 60 * ((1 - t) ** 2 + t ** 2) - 24 * t * (1 - t);
  const cum = [0];
  for (let i = 1; i <= N; i++) {
    cum.push(cum[i - 1] + Math.hypot(375 / N, y(i / N) - y((i - 1) / N)));
  }
  return cum.map((c) => c / cum[N]);
})();

function arcLengthFrac(t: number): number {
  const f = Math.max(0, Math.min(1, t)) * 64;
  const i = Math.min(63, Math.floor(f));
  return ARC_LENGTH_FRACS[i] + (ARC_LENGTH_FRACS[i + 1] - ARC_LENGTH_FRACS[i]) * (f - i);
}
export function QuizProgressArc({ progress }: { progress: number }) {
  // Front-load the travel curve so the first handful of questions visibly
  // advance the marker faster (18% raw reads as ~30%); converges back to 1 by
  // the final step so the finish stays honest.
  const eased = Math.max(0, Math.min(1, progress)) ** 0.7;
  // Keep the marker on-screen across its travel (never flush to the edges).
  const p = 0.08 + 0.84 * eased;
  const markerXPct = p * 100; // x along a symmetric quadratic arc is linear in p
  const markerY = 60 * ((1 - p) ** 2 + p ** 2) - 24 * p * (1 - p);

  return (
    <div style={{ position: 'relative', width: '100%', height: 72, flex: '0 0 auto', overflow: 'visible' }}>
      <svg
        viewBox="0 0 375 72"
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, display: 'block' }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="qpaDome" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#241048" />
            <stop offset="1" stopColor="#150a2e" />
          </linearGradient>
          <filter id="qpaGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Dome fill under the arc */}
        <path d="M0 60 Q187.5 -12 375 60 L375 72 L0 72 Z" fill="url(#qpaDome)" />

        {/* Unlit remainder of the path — darker than the lavender sky so it
            reads as clearly "not yet travelled" next to the glowing trail
            (a purple tint here blends into the light background and makes
            the whole arc look lit, hiding where the trail ends). */}
        <path d={ARC_PATH} fill="none" stroke="rgba(58,37,102,0.45)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path
          d={ARC_PATH}
          fill="none"
          stroke="var(--quiz-accent, #7f4cf2)"
          strokeWidth="2.6"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={100 * (1 - arcLengthFrac(p))}
          filter="url(#qpaGlow)"
        />
      </svg>

      {/* Marker at the current progress point. `top` is a percentage of the
          footer height (not raw px) so the marker tracks the SVG's viewBox→box
          vertical mapping exactly — it stays welded to the arc line even if the
          footer ever renders taller/shorter than its 72px viewBox (e.g. Safari
          SVG height quirks), instead of floating above it. */}
      <div
        style={{
          position: 'absolute',
          left: `${markerXPct}%`,
          top: `${(markerY / 72) * 100}%`,
          transform: 'translate(-50%, -50%)',
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'radial-gradient(circle at 50% 38%, #3a2566 0%, #241048 100%)',
          border: '2px solid rgba(255,255,255,0.85)',
          boxShadow: '0 0 12px 2px rgba(127,76,242,0.55)',
        }}
      />
    </div>
  );
}
