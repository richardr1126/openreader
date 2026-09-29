import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const baseSvg = (props: IconProps) => {
  const { width = '1em', height = '1em', ...rest } = props;
  return {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  width,
  height,
  ...rest,
  };
};

export const SearchIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const FolderIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <path d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.6c.5 0 1 .2 1.4.6l1.4 1.4c.4.4.9.6 1.4.6H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.5Z" />
  </svg>
);

export const FolderPlusIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <path d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.6c.5 0 1 .2 1.4.6l1.4 1.4c.4.4.9.6 1.4.6H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.5Z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </svg>
);

export const IconsViewIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <rect x="14" y="14" width="6" height="6" rx="1" />
  </svg>
);

export const ListViewIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

export const GalleryViewIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <rect x="4" y="4" width="16" height="13" rx="1.5" />
    <path d="M5 20h14" />
  </svg>
);

export const HamburgerIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const ClockIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const HomeIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <path d="m3 11 9-7 9 7" />
    <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
  </svg>
);

export const TrashIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l.9 11.1A2 2 0 0 0 8.9 20h6.2a2 2 0 0 0 2-1.9L18 7M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
  </svg>
);

export const CloseIcon = (props: IconProps) => (
  <svg {...baseSvg(props)}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

export const CheckMarkIcon = (props: IconProps) => (
  <svg {...baseSvg({ ...props, strokeWidth: 2.4 })}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
