export const BRIEFING_CSS = `
:root {
  --ink: #1b1a17;
  --ink-soft: #5f5e5a;
  --ink-faint: #8a8880;
  --paper: #fdfcf9;
  --card: #ffffff;
  --rule: #e3e0d6;
  --accent: #993c1d;
  --accent-soft: #faece7;
  --warn: #854f0b;
  --warn-soft: #faeeda;
  --stop: #a32d2d;
  --stop-soft: #fcebeb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #f1efe8;
    --ink-soft: #b4b2a9;
    --ink-faint: #888780;
    --paper: #1a1918;
    --card: #232220;
    --rule: #3a3833;
    --accent: #f0997b;
    --accent-soft: #35241d;
    --warn: #fac775;
    --warn-soft: #33260f;
    --stop: #f09595;
    --stop-soft: #331818;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 400 16px/1.65 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
h1 { font-size: 1.9rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 0.25rem; }
h2 { font-size: 1.15rem; font-weight: 600; margin: 2.75rem 0 0.75rem; }
h3 { font-size: 1rem; font-weight: 600; margin: 0 0 0.15rem; }
.sub { color: var(--ink-soft); margin: 0 0 2rem; }
.day { border-top: 1px solid var(--rule); margin-top: 2.5rem; padding-top: 0.5rem; }
.day:first-of-type { border-top: 0; }
.stop { margin: 1.5rem 0; }
.stop-head { display: flex; gap: 0.6rem; align-items: baseline; }
.time { color: var(--ink-faint); font-variant-numeric: tabular-nums; font-size: 0.875rem; }
.card {
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  margin: 0.6rem 0;
}
.card p { margin: 0.2rem 0 0; }
.card-kind {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  font-weight: 500;
}
.card[data-tier="safety"] { border-color: var(--stop); background: var(--stop-soft); border-radius: 4px; }
.card[data-tier="safety"] .card-kind { color: var(--stop); }
.card[data-tier="operational"] { border-color: var(--rule); border-left: 3px solid var(--accent); border-radius: 0; }
.prov { margin-top: 0.5rem; font-size: 0.78rem; color: var(--ink-faint); }
.prov a { color: var(--ink-soft); }
.stale { color: var(--warn); background: var(--warn-soft); padding: 0.1rem 0.35rem; border-radius: 3px; }
.leg {
  display: flex; gap: 0.6rem; align-items: baseline;
  margin: 0.75rem 0 0.75rem 0.1rem; padding-left: 0.9rem;
  border-left: 2px dotted var(--rule); color: var(--ink-soft); font-size: 0.925rem;
}
.leg-mode { font-weight: 500; color: var(--ink); text-transform: capitalize; }
.gap {
  border: 1px dashed var(--rule); border-radius: 8px;
  padding: 0.75rem 1rem; margin: 0.6rem 0;
  color: var(--ink-soft); font-size: 0.925rem;
}
.gap strong { color: var(--ink); font-weight: 500; }
.controls { display: flex; gap: 0.5rem; margin-top: 0.55rem; }
.controls button {
  font: inherit; font-size: 0.78rem; padding: 0.2rem 0.55rem;
  border: 1px solid var(--rule); border-radius: 999px;
  background: transparent; color: var(--ink-soft); cursor: pointer;
}
.controls button:hover { border-color: var(--ink-faint); color: var(--ink); }
.footnotes { margin-top: 4rem; border-top: 1px solid var(--rule); padding-top: 1rem;
  font-size: 0.8rem; color: var(--ink-faint); }
.footnotes ol { padding-left: 1.2rem; margin: 0.5rem 0 0; }
@media print {
  :root {
    --ink: #000; --ink-soft: #333; --ink-faint: #555;
    --paper: #fff; --card: #fff; --rule: #bbb;
    --accent: #000; --accent-soft: #fff;
    --warn: #000; --warn-soft: #fff; --stop: #000; --stop-soft: #fff;
  }
  body { font-size: 11pt; }
  .wrap { max-width: none; padding: 0; }
  .controls { display: none; }
  .card, .stop, .gap { break-inside: avoid; }
  .day { break-before: page; }
  .day:first-of-type { break-before: auto; }
  .card[data-tier="safety"] { border: 2px solid #000; }
  a { text-decoration: none; color: inherit; }
}
`
