import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** 16×16 stroke icons. Decorative by default; give the parent button an aria-label. */
function Icon({ children, strokeWidth = 1.5, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const NoteIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 2.5h7l3 3v8H3z" />
    <path d="M5.5 8h5M5.5 10.5h3.5" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Icon>
);

export const TagIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 2.5 5 13.5M11 2.5 9.5 13.5M3 6h10.5M2.5 10H13" />
  </Icon>
);

export const CalendarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </Icon>
);

export const HistoryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7" />
    <path d="M2.5 2.5v2.5H5M8 5v3l2 1.5" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Icon>
);

export const ChevronDown = (p: IconProps) => (
  <Icon strokeWidth={1.7} {...p}>
    <path d="m4 6 4 4 4-4" />
  </Icon>
);

export const ChevronUp = (p: IconProps) => (
  <Icon strokeWidth={1.7} {...p}>
    <path d="m4 10 4-4 4 4" />
  </Icon>
);

export const ChevronRight = (p: IconProps) => (
  <Icon strokeWidth={1.7} {...p}>
    <path d="m6 4 4 4-4 4" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon strokeWidth={1.6} {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon strokeWidth={1.6} {...p}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Icon>
);

export const SyncIcon = (p: IconProps) => (
  <Icon strokeWidth={1.6} {...p}>
    <path d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5a5 5 0 0 0 9.4 1.5" />
    <path d="M3.5 2.5V5H6M12.5 13.5V11H10" />
  </Icon>
);

/** An arrow into a tray: a new version to download. */
export const UpdateIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5v7M5 6.5l3 3 3-3" />
    <path d="M3 10.5v3h10v-3" />
  </Icon>
);

/** ± : the Changes toggle. */
export const ChangesIcon = (p: IconProps) => (
  <Icon strokeWidth={1.6} {...p}>
    <path d="M5 2.5v5M2.5 5h5M8.5 12h5" />
  </Icon>
);

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon strokeWidth={1.8} {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);

export const MoreIcon = (p: IconProps) => (
  <Icon strokeWidth={2.2} {...p}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </Icon>
);

// Window caption glyphs, drawn on a 10×10 grid like Windows 11's.
export const MinimizeGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M0 5h10" stroke="currentColor" />
  </svg>
);

export const MaximizeGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
  </svg>
);

export const RestoreGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" />
    <path d="M2.5 2.5V.5h7v7h-2" stroke="currentColor" />
  </svg>
);

export const CloseGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M0 0l10 10M10 0 0 10" stroke="currentColor" />
  </svg>
);
