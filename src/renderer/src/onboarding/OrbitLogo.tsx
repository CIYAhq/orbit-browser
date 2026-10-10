/**
 * Orbit's icon (build/icon.svg), drawn live for the welcome screen (OB-01): the moon travels the
 * ring once every few seconds. With reduced motion it stays where the app icon has it.
 */
export function OrbitLogo({ size, moving }: { size: number; moving: boolean }) {
  return (
    <svg className="ob-logo" viewBox="100 100 824 824" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="ob-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7b8cff" />
          <stop offset="0.55" stopColor="#6a5cf0" />
          <stop offset="1" stopColor="#3d2fa8" />
        </linearGradient>
        <radialGradient id="ob-logo-glow" cx="0.32" cy="0.28" r="0.75">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ob-logo-planet" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dcd8ff" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#ob-logo-bg)" />
      <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#ob-logo-glow)" />
      <g transform="rotate(-28 512 512)">
        <ellipse
          cx="512"
          cy="512"
          rx="300"
          ry="118"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.92"
          strokeWidth="34"
        />
      </g>
      <circle cx="512" cy="512" r="128" fill="url(#ob-logo-planet)" />
      <g transform="rotate(-28 512 512)">
        <path
          d="M 212 512 A 300 118 0 0 0 812 512"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.92"
          strokeWidth="34"
          strokeLinecap="round"
        />
        {moving && (
          <circle r="34" fill="#ffd36e" data-testid="onboarding-moon">
            <animateMotion
              dur="7s"
              repeatCount="indefinite"
              path="M 812 512 A 300 118 0 1 0 212 512 A 300 118 0 1 0 812 512"
            />
          </circle>
        )}
      </g>
      {!moving && <circle cx="770" cy="352" r="34" fill="#ffd36e" />}
    </svg>
  )
}
