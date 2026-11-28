import { useId } from 'react';
import { VisualDialog } from './VisualDialog';
import styles from './MarkdownDocument.module.css';

// Render only flat state transitions. Preserve the full source for other Mermaid syntax.
export function StateDiagram({ source }: { source: string }) {
  const marker = useId();
  const lines = source
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('%%'));
  if (!/^stateDiagram(?:-v2)?$/.test(lines.shift() ?? '') || lines.length > 32)
    return null;
  const names = new Map<string, string>();
  const nodes: string[] = [];
  const edges: { from: number; to: number; label: string }[] = [];
  function node(id: string) {
    if (!nodes.includes(id)) nodes.push(id);
    return nodes.indexOf(id);
  }
  for (const line of lines) {
    const alias = /^state\s+"([^"]{1,50})"\s+as\s+([\p{L}\w-]+)$/u.exec(line);
    if (alias) {
      names.set(alias[2]!, alias[1]!);
      continue;
    }
    const match =
      /^([\p{L}\w-]+|\[\*\])\s*-->\s*([\p{L}\w-]+|\[\*\])(?:\s*:\s*(.{1,60}))?$/u.exec(
        line,
      );
    if (!match) return null;
    edges.push({
      from: node(match[1] === '[*]' ? '(start)' : match[1]!),
      to: node(match[2] === '[*]' ? '(end)' : match[2]!),
      label: match[3] ?? '',
    });
  }
  if (!edges.length || nodes.some((n) => n.length > 50)) return null;
  const label = (n: string) =>
    names.get(n) ?? { '(start)': 'Start', '(end)': 'End' }[n] ?? n;
  const box = Math.max(
    110,
    ...nodes.map((n) => Array.from(label(n)).length * 16 + 26),
  );
  const height = Math.max(nodes.length * 62 + 20, edges.length * 22 + 16);
  const transitionLabel = (e: (typeof edges)[number]) =>
    label(nodes[e.from]!) +
    ' → ' +
    label(nodes[e.to]!) +
    (e.label ? ' · ' + e.label : '');
  const width =
    box +
    62 +
    edges.length * 24 +
    Math.max(
      40,
      ...edges.map((e) => Array.from(transitionLabel(e)).length * 16 + 32),
    );
  const drawing = (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="State transitions"
    >
      <defs>
        <marker
          id={marker}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0 0L10 5L0 10Z" fill="currentColor" />
        </marker>
      </defs>
      {nodes.map((n, i) => (
        <g key={n}>
          <rect
            x="4"
            y={16 + i * 62}
            width={box}
            height="38"
            rx="8"
            fill="var(--wash)"
            stroke="currentColor"
          />
          <text x={4 + box / 2} y={40 + i * 62} textAnchor="middle">
            {label(n)}
          </text>
        </g>
      ))}
      {edges.map((e, i) => {
        const x = box + 4,
          lane = x + 24 + i * 24,
          y = 28 + e.from * 62,
          end = 42 + e.to * 62;
        return (
          <g key={i}>
            <path
              d={`M${x} ${y} H${lane} V${end} H${x + 2}`}
              stroke="currentColor"
              fill="none"
              markerEnd={`url(#${marker})`}
            />
            <text x={box + 38 + edges.length * 24} y={18 + i * 22}>
              {i + 1}. {transitionLabel(e)}
            </text>
            <text x={lane + 3} y={y - 2} fontSize="11">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
  return (
    <VisualDialog label="Open state diagram">
      <div className={styles.diagramScroll}>{drawing}</div>
      <pre>
        <code>{source}</code>
      </pre>
    </VisualDialog>
  );
}
