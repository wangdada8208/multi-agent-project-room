export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path
        d="M9 24V8h14v16"
        fill="none"
        stroke="var(--logo-paper, #fffdf8)"
        strokeWidth="1.8"
        strokeLinecap="square"
      />
      <path
        d="M13 24V12.2l7-2.4V24"
        fill="var(--logo-paper, #fffdf8)"
        opacity="0.92"
      />
      <path
        d="M18.8 15.8h.01"
        stroke="var(--logo-seal, #54b98f)"
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      <path
        d="M10.5 10.5h4M10.5 13h2.5"
        stroke="var(--logo-seal, #54b98f)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
