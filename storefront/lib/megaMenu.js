/**
 * Mega-menu layout (PCPartPicker-style).
 * Tile `href` values point at your Shopify collections — create matching handles or adjust here.
 * Multiple tiles can share `pc-parts` until you split collections (CPUs, GPUs, etc.).
 */

export const MEGA_TILES = [
  { label: 'CPUs', href: '/collection/pc-parts', accent: 'linear-gradient(145deg, #1e4976 0%, #0c1929 100%)' },
  { label: 'CPU Coolers', href: '/collection/pc-parts', accent: 'linear-gradient(145deg, #2d4a6f 0%, #0f172a 100%)' },
  { label: 'Motherboards', href: '/collection/pc-parts', accent: 'linear-gradient(145deg, #1a4d5c 0%, #0c1f24 100%)' },
  { label: 'Memory', href: '/collection/pc-parts', accent: 'linear-gradient(145deg, #3d2d5c 0%, #1a1028 100%)' },
  { label: 'Storage', href: '/collection/pc-parts', accent: 'linear-gradient(145deg, #1f3d4d 0%, #0d1820 100%)' },
  { label: 'Video Cards', href: '/collection/pc-parts', accent: 'linear-gradient(145deg, #4a2d4d 0%, #1a0f1c 100%)' },
  { label: 'Power Supplies', href: '/collection/pc-parts', accent: 'linear-gradient(145deg, #3d3a2d 0%, #1c1a12 100%)' },
  { label: 'Cases', href: '/collection/pc-parts', accent: 'linear-gradient(145deg, #2d3d4a 0%, #121a20 100%)' },
];

export const MEGA_COLUMNS = [
  {
    heading: 'Peripherals',
    links: [
      { label: 'Headphones', href: '/collection/peripherals' },
      { label: 'Keyboards', href: '/collection/peripherals' },
      { label: 'Mice', href: '/collection/peripherals' },
      { label: 'Speakers', href: '/collection/peripherals' },
      { label: 'Webcams', href: '/collection/peripherals' },
    ],
  },
  {
    heading: 'Displays',
    links: [{ label: 'Monitors', href: '/collection/monitors' }],
  },
  {
    heading: 'Software',
    links: [
      { label: 'Operating systems', href: '/collection/misc' },
      { label: 'Utilities', href: '/collection/misc' },
    ],
  },
  {
    heading: 'Expansion',
    links: [
      { label: 'Sound cards', href: '/collection/pc-parts' },
      { label: 'Networking', href: '/collection/pc-parts' },
    ],
  },
  {
    heading: 'Accessories',
    links: [
      { label: 'Case fans', href: '/collection/misc' },
      { label: 'Cables & adapters', href: '/collection/misc' },
      { label: 'Thermal compound', href: '/collection/misc' },
      { label: 'UPS & power', href: '/collection/misc' },
    ],
  },
];

/** Top nav items (non-Products). My orders lives in the utility bar. */
export const MAIN_NAV_LINKS = [
  { label: 'Build list', href: '/build', icon: 'wrench' },
  { label: 'Guides', href: '/#guides', icon: 'book' },
];
