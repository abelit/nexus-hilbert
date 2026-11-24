// OngridLogo — inline SVG so we get sharpness at any size + can theme on
// light/dark without an extra HTTP fetch.
//
// Artwork is the Nexus-Hilbert "Duo Glow" symbol (deliverables/duo-glow-kit):
// four corner brackets converging on a frosted diamond. Static copies ship at
// public/ongrid-logo.svg and public/favicon.svg (light variant).
//
// The kit has two approved variants — pastel for light surfaces, brighter
// brackets for dark UI — and brand rules forbid the light one on a dark
// background, where the right bracket loses contrast. Both are rendered and
// Tailwind's `.dark` class picks one, so every surface (including the sidebar
// and sign-in, which follow the app theme) gets the right variant.
//
// Color stops match the approved kit:
//   light: left #E75DC9 → #956BEB, right #226FBC → #4EC9D5
//   dark:  left #F27BDA → #AE90FF, right #4E96E8 → #6FE0F0
//   core glow layers: magenta / violet / azure / cyan + frosted white

import { useId } from 'react';

type Props = {
  /** Pixel size (square). Default 28 — sidebar / header scale. */
  size?: number;
  className?: string;
  /** title for screen readers (default "Ongrid"). */
  title?: string;
};

type Theme = 'light' | 'dark';

const BRACKET_PATHS = {
  tl: 'M36 102V48A12 12 0 0 1 48 36H102V66H66V102Z',
  tr: 'M154 36H208A12 12 0 0 1 220 48V102H190V66H154Z',
  br: 'M220 154V208A12 12 0 0 1 208 220H154V190H190V154Z',
  bl: 'M102 220H48A12 12 0 0 1 36 208V154H66V190H102Z',
} as const;

const CORE_PATH = 'M128 86L170 128L128 170L86 128Z';

const BRACKET_KEYS = ['tl', 'tr', 'br', 'bl'] as const;

// Gradient anchors in the 256-unit source grid.
const BRACKET_ANCHORS: Record<(typeof BRACKET_KEYS)[number], readonly [number, number, number, number]> = {
  tl: [36, 36, 102, 102],
  tr: [220, 36, 154, 102],
  br: [220, 220, 154, 154],
  bl: [36, 220, 102, 154],
};

const CORE_LAYERS = [
  { name: 'mag', cx: 96, cy: 96 },
  { name: 'vio', cx: 96, cy: 160 },
  { name: 'azr', cx: 160, cy: 96 },
  { name: 'cyn', cx: 160, cy: 160 },
] as const;

const PALETTES = {
  light: {
    warm: ['#E75DC9', '#956BEB'],
    cool: ['#226FBC', '#4EC9D5'],
    mag: '#D94FC2',
    vio: '#956BEB',
    azr: '#2C7FCC',
    cyn: '#4EC9D5',
    glowPeak: '0.62',
  },
  dark: {
    warm: ['#F27BDA', '#AE90FF'],
    cool: ['#4E96E8', '#6FE0F0'],
    mag: '#E86BCF',
    vio: '#A98CFF',
    azr: '#4E96E8',
    cyn: '#6FE0F0',
    glowPeak: '0.56',
  },
} as const;

function Symbol({ theme, idPrefix, className }: { theme: Theme; idPrefix: string; className?: string }) {
  const palette = PALETTES[theme];
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <g className={className}>
      <defs>
        {BRACKET_KEYS.map(key => {
          const [x1, y1, x2, y2] = BRACKET_ANCHORS[key];
          const [from, to] = key === 'tl' || key === 'bl' ? palette.warm : palette.cool;
          return (
            <linearGradient key={key} id={id(`bracket-${key}`)} x1={x1} y1={y1} x2={x2} y2={y2} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor={from} />
              <stop offset="1" stopColor={to} />
            </linearGradient>
          );
        })}
        {CORE_LAYERS.map(layer => (
          <radialGradient key={layer.name} id={id(`core-${layer.name}`)} cx={layer.cx} cy={layer.cy} r="58" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={palette[layer.name]} stopOpacity="0.95" />
            <stop offset="0.5" stopColor={palette[layer.name]} stopOpacity="0.42" />
            <stop offset="1" stopColor={palette[layer.name]} stopOpacity="0" />
          </radialGradient>
        ))}
        <radialGradient id={id('core-glow')} cx="121" cy="117" r="52" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity={palette.glowPeak} />
          <stop offset="0.5" stopColor="#F4F7FF" stopOpacity="0.24" />
          <stop offset="1" stopColor="#F4F7FF" stopOpacity="0" />
        </radialGradient>
      </defs>
      {BRACKET_KEYS.map(key => (
        <path key={key} fill={`url(#${id(`bracket-${key}`)})`} d={BRACKET_PATHS[key]} />
      ))}
      <path fill="#F4F7FF" d={CORE_PATH} />
      {CORE_LAYERS.map(layer => (
        <path key={layer.name} fill={`url(#${id(`core-${layer.name}`)})`} d={CORE_PATH} />
      ))}
      <path fill={`url(#${id('core-glow')})`} d={CORE_PATH} />
    </g>
  );
}

export function OngridLogo({ size = 28, className, title = 'Ongrid' }: Props) {
  // useId keeps gradient ids unique when the logo appears more than once on a
  // page; strip the colons React adds so the ids stay valid in url(#...).
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <Symbol theme="light" idPrefix={`${uid}l`} className="dark:hidden" />
      <Symbol theme="dark" idPrefix={`${uid}d`} className="hidden dark:block" />
    </svg>
  );
}
