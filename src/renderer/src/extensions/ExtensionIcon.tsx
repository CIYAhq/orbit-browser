import { Puzzle } from 'lucide-react'

/** An extension's own icon (a PNG data URL main made from its files), or the generic piece. */
export function ExtensionIcon({ icon, size = 32, testId }: { icon: string; size?: number; testId?: string }) {
  if (icon.startsWith('data:image/png;base64,')) {
    return (
      <img
        className="ext-icon"
        src={icon}
        alt=""
        width={size}
        height={size}
        draggable={false}
        data-testid={testId}
        data-generic="false"
      />
    )
  }
  return (
    <span
      className="ext-icon ext-icon--generic"
      style={{ width: size, height: size }}
      data-testid={testId}
      data-generic="true"
    >
      <Puzzle size={Math.round(size * 0.6)} strokeWidth={1.75} aria-hidden />
    </span>
  )
}
