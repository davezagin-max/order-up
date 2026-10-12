/** Inline icons. Decorative: every control that uses one has a text label or aria-label. */

interface IconProps {
  className?: string;
}

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function MicIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M7 4.6v14.8a.8.8 0 0 0 1.2.7l12-7.4a.8.8 0 0 0 0-1.4l-12-7.4A.8.8 0 0 0 7 4.600Z" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function SkipIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="m5 5 9 7-9 7V5ZM18.5 5v14" />
    </svg>
  );
}

export function SoundOnIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.500 9.500H4ZM15.5 9a4 4 0 0 1 0 6M18 6.500a7.500 7.500 0 0 1 0 11" />
    </svg>
  );
}

export function SoundOffIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.500 9.500H4ZM16 9.500l5 5M21 9.500l-5 5" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={2.4} className={className}>
      <path d="m5 12.500 4.500 4.500L19 7.500" />
    </svg>
  );
}

export function CrossIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={2.4} className={className}>
      <path d="M6.500 6.500l11 11M17.500 6.500l-11 11" />
    </svg>
  );
}

export function BagIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5.500 8.500h13l-1 11.500h-11l-1-11.500ZM9 8.500V7a3 3 0 0 1 6 0v1.500" />
    </svg>
  );
}

export function ChevronIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={2.2} className={className}>
      <path d="m6.500 9.500 5.500 5.500 5.500-5.500" />
    </svg>
  );
}

export function LockIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="5.500" y="10.500" width="13" height="9.500" rx="2" />
      <path d="M8.500 10.500V8a3.500 3.500 0 0 1 7 0v2.500" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg {...base} strokeWidth={2} className={className}>
      <path d="M5 12h13M12.500 6l6 6-6 6" />
    </svg>
  );
}
