// A few stroke icons, drawn on a 16×16 grid in the current text color.

import type { NodeCategory, Severity } from '../../shared/types';

const paths: Record<string, string> = {
  chevron: 'M6 4l4 4-4 4',
  plus: 'M8 3v10M3 8h10',
  subtree: 'M3 3v6h6M7 7l2 2-2 2M11 5h2v8H6v-2',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  back: 'M13 8H3M7 4L3 8l4 4',
  forward: 'M3 8h10M9 4l4 4-4 4',
  undo: 'M5 3L2 6l3 3M2.5 6H10a3.5 3.5 0 010 7H7',
  redo: 'M11 3l3 3-3 3M13.5 6H6a3.5 3.5 0 000 7h3',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  cut: 'M5 11.5a1.5 1.5 0 11-.01 0M11 11.5a1.5 1.5 0 11.01 0M6 10.5L11 3M10 10.5L5 3',
  paste: 'M5.5 3.5h-2v10h9v-10h-2M6 2.5h4v2H6z',
  duplicate: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7M9 7.5v3M7.5 9h3',
  save: 'M3 3h8l2 2v8H3zM5.5 3v3h4.5V3M5 13V9.5h6V13',
  refresh: 'M13 8a5 5 0 11-1.5-3.6M13 2.5v2.5h-2.5',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  newFile: 'M4 2h5l3 3v9H4zM9 2v3h3M8 7.5v4M6 9.5h4',
  folder: 'M2 4h4l1.5 1.5H14V13H2z',
  expand: 'M4 6l4 4 4-4M4 2.5h8',
  collapse: 'M4 10l4-4 4 4M4 13.5h8',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
  tree: 'M3 3h4v3H3zM9 10h4v3H9zM5 6v5.5h4',
  nodes: 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z',
  check: 'M3 8.5l3 3 7-7',
  open: 'M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5',
  search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM10.5 10.5L14 14',
  wrap: 'M2.5 4.5v7M13.5 4.5v7M5.5 6.5h5v3h-5z',
  close: 'M4 4l8 8M12 4l-8 8',
  disable: 'M8 14A6 6 0 108 2a6 6 0 000 12zM3.8 3.8l8.4 8.4',
  play: 'M5 3l8 5-8 5z',
  cog: 'M8 10.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM6.9 1.8h2.2l.4 1.8 1.2.5 1.6-1 1.5 1.5-1 1.6.5 1.2 1.8.4v2.2l-1.8.4-.5 1.2 1 1.6-1.5 1.5-1.6-1-1.2.5-.4 1.8H6.9l-.4-1.8-1.2-.5-1.6 1-1.5-1.5 1-1.6-.5-1.2-1.8-.4V6.9l1.8-.4.5-1.2-1-1.6 1.5-1.5 1.6 1 1.2-.5z',
};

export function Icon({ name, size = 16, className }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

const LETTERS: Record<NodeCategory, string> = {
  Control: 'C', Decorator: 'D', Action: 'A', Condition: '?', SubTree: 'S',
};

/** The badge of a category; `plain` leaves out the tooltip, e.g. next to the category's name. */
export function CategoryBadge({ category, plain = false }: { category?: NodeCategory; plain?: boolean }) {
  return (
    <span className={`badge cat-${category ?? 'Unknown'}`} title={plain ? undefined : category ?? 'Unknown node type'}>
      {category === 'SubTree' ? <Icon name="subtree" size={12} /> : category ? LETTERS[category] : '!'}
    </span>
  );
}

export function SeverityIcon({ severity }: { severity: Severity }) {
  return <span className={`sev sev-${severity}`} aria-label={severity}>{severity === 'error' ? '✕' : severity === 'warning' ? '!' : 'i'}</span>;
}

export function Counts({ errors, warnings }: { errors: number; warnings: number }) {
  if (!errors && !warnings) return null;
  return (
    <span className="counts">
      {errors > 0 && <span className="count count-error" title={`${errors} errors`}>{errors}</span>}
      {warnings > 0 && <span className="count count-warning" title={`${warnings} warnings`}>{warnings}</span>}
    </span>
  );
}
