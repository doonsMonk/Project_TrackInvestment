// Chart builders. Uses Chart.js (global `Chart`, loaded from CDN in index.html).
// Colors are read from CSS custom properties so light / dark themes stay in one place (styles.css).

import { fmtINR, fmtCompact, fmtDate, fmtAxisDate, fmtPct, esc, daysBetween, isNum } from './format.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function themeTokens() {
  return {
    series1: cssVar('--series-1'),
    series2: cssVar('--series-2'),
    grid: cssVar('--grid'),
    axis: cssVar('--axis'),
    muted: cssVar('--text-muted'),
    secondary: cssVar('--text-secondary'),
    ink: cssVar('--text-primary'),
    surface: cssVar('--surface-1'),
  };
}

/** Vertical hairline at the hovered index (crosshair). */
const crosshairPlugin = (theme) => ({
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const { top, bottom } = chart.chartArea;
    const x = active[0].element.x;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
});

/** Direct value label at the end of each line (skipped when it would collide with another). */
const endLabelsPlugin = (theme) => ({
  id: 'endLabels',
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    const placed = [];
    chart.data.datasets.forEach((ds, i) => {
      if (!chart.isDatasetVisible(i)) return;
      const meta = chart.getDatasetMeta(i);
      const pt = meta.data[meta.data.length - 1];
      const val = ds.data[ds.data.length - 1];
      if (!pt || !isNum(val)) return;
      if (placed.some((y) => Math.abs(y - pt.y) < 14)) return; // legend + tooltip carry it instead
      placed.push(pt.y);
      ctx.save();
      ctx.font = `600 12px ${FONT}`;
      ctx.fillStyle = theme.ink;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(fmtCompact(val), pt.x + 8, pt.y);
      ctx.restore();
    });
  },
});

function lineDataset(label, data, color, surface, extra = {}) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    borderJoinStyle: 'round',
    borderCapStyle: 'round',
    pointRadius: 0,
    pointHitRadius: 12,
    pointHoverRadius: 5,
    pointHoverBorderWidth: 2,
    pointHoverBorderColor: surface,
    pointHoverBackgroundColor: color,
    fill: false,
    tension: 0,
    ...extra,
  };
}

/**
 * Line chart of current value vs invested amount over time.
 * history: [{ date: 'YYYY-MM-DD', value, invested }] ascending.
 */
export function valueChart(canvas, history) {
  const t = themeTokens();
  const view = { span: spanDays(history) }; // shared with tick callback; updated on range change
  Chart.defaults.font.family = FONT;
  Chart.defaults.font.size = 12;

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: history.map((p) => p.date),
      datasets: [
        lineDataset('Current value', history.map((p) => p.value), t.series1, t.surface),
        lineDataset('Invested', history.map((p) => p.invested), t.series2, t.surface, { stepped: 'after' }),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { right: 76, top: 8 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { boxWidth: 20, boxHeight: 3, color: t.secondary, padding: 16 },
        },
        tooltip: {
          backgroundColor: t.surface,
          titleColor: t.ink,
          bodyColor: t.secondary,
          footerColor: t.ink,
          borderColor: t.axis,
          borderWidth: 1,
          padding: 10,
          usePointStyle: true,
          boxPadding: 4,
          callbacks: {
            title: (items) => fmtDate(items[0]?.label),
            label: (item) => ` ${item.dataset.label}: ${fmtINR(item.parsed.y)}`,
            footer: (items) => {
              const v = items.find((i) => i.datasetIndex === 0)?.parsed.y;
              const inv = items.find((i) => i.datasetIndex === 1)?.parsed.y;
              if (!isNum(v) || !isNum(inv) || inv === 0) return '';
              const p = v - inv;
              return `${p >= 0 ? 'Gain' : 'Loss'}: ${fmtINR(Math.abs(p))} (${fmtPct((p / inv) * 100)})`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: t.axis },
          ticks: {
            color: t.muted,
            maxTicksLimit: 8,
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 24,
            callback(value) {
              return fmtAxisDate(this.getLabelForValue(value), view.span);
            },
          },
        },
        y: {
          grid: { color: t.grid, lineWidth: 1, drawTicks: false },
          border: { display: false },
          grace: '5%',
          ticks: { color: t.muted, maxTicksLimit: 6, padding: 8, callback: (v) => fmtCompact(v) },
        },
      },
    },
    plugins: [crosshairPlugin(t), endLabelsPlugin(t)],
  });
  chart.$view = view;
  return chart;
}

export function updateValueChart(chart, history) {
  chart.data.labels = history.map((p) => p.date);
  chart.data.datasets[0].data = history.map((p) => p.value);
  chart.data.datasets[1].data = history.map((p) => p.invested);
  chart.$view.span = spanDays(history);
  chart.update('none');
}

function spanDays(history) {
  return history.length > 1 ? daysBetween(history[0].date, history[history.length - 1].date) : 0;
}

/**
 * Thin segmented bar: one whole split into parts (e.g. redeemable vs locked value).
 * parts: [{ label, value, color }]. Returns HTML.
 */
export function segmentedBar(parts, { ariaLabel = '' } = {}) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value || 0), 0);
  if (!total) return '';
  const share = (v) => `${((v / total) * 100).toFixed(1)}%`;
  const segs = parts
    .filter((p) => p.value > 0)
    .map(
      (p) =>
        `<span class="seg" style="flex:${p.value} 1 0;background:${p.color}" title="${esc(p.label)}: ${fmtINR(p.value)} (${share(p.value)})"></span>`,
    )
    .join('');
  const legend = parts
    .map(
      (p) =>
        `<span class="legend-item"><i class="swatch" style="background:${p.color}"></i>${esc(p.label)} <b>${fmtINR(p.value)}</b> <span class="muted">${share(p.value || 0)}</span></span>`,
    )
    .join('');
  return `<div class="segbar" role="img" aria-label="${esc(ariaLabel)}">${segs}</div><div class="legend-row">${legend}</div>`;
}
