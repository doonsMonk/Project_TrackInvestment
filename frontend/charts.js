// Chart builders. Uses Chart.js (global `Chart`, loaded from CDN in index.html).
// Colors are read from CSS custom properties so light / dark themes stay in one place (styles.css).

import { fmtMoney, fmtCompact, fmtDate, fmtAxisDate, fmtPct, esc, daysBetween, isNum } from './format.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function themeTokens() {
  return {
    series1: cssVar('--series-1'),
    series2: cssVar('--series-2'),
    series3: cssVar('--series-3'),
    series4: cssVar('--series-4'),
    series5: cssVar('--series-5'),
    series6: cssVar('--series-6'),
    series7: cssVar('--series-7'),
    series8: cssVar('--series-8'),
    grid: cssVar('--grid'),
    axis: cssVar('--axis'),
    muted: cssVar('--text-muted'),
    secondary: cssVar('--text-secondary'),
    ink: cssVar('--text-primary'),
    surface: cssVar('--surface-1'),
  };
}

/** The categorical colours in their fixed order (slot 1 = first asset class, and so on). */
export function seriesColors() {
  const t = themeTokens();
  return [t.series1, t.series2, t.series3, t.series4, t.series5, t.series6, t.series7, t.series8];
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
const endLabelsPlugin = (theme, currency) => ({
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
      ctx.fillText(fmtCompact(val, currency), pt.x + 8, pt.y);
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
 * history: [{ date: 'YYYY-MM-DD', value, invested }] ascending; currency formats the axis and tooltips.
 */
export function valueChart(canvas, history, { currency = 'INR' } = {}) {
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
            label: (item) => ` ${item.dataset.label}: ${fmtMoney(item.parsed.y, currency)}`,
            footer: (items) => {
              const v = items.find((i) => i.datasetIndex === 0)?.parsed.y;
              const inv = items.find((i) => i.datasetIndex === 1)?.parsed.y;
              if (!isNum(v) || !isNum(inv) || inv === 0) return '';
              const p = v - inv;
              return `${p >= 0 ? 'Gain' : 'Loss'}: ${fmtMoney(Math.abs(p), currency)} (${fmtPct((p / inv) * 100)})`;
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
          ticks: { color: t.muted, maxTicksLimit: 6, padding: 8, callback: (v) => fmtCompact(v, currency) },
        },
      },
    },
    plugins: [crosshairPlugin(t), endLabelsPlugin(t, currency)],
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
 * Stacked columns, one per label (e.g. one per financial year), each split into the given series bottom to top.
 * series: [{ label, data: number[], color, placeholder?: (index) => string | null }] in a fixed order; a
 * placeholder names why a value is 0 (for example "pending") in the tooltip. Segments are separated by a 2px
 * gap in the surface colour, the top of each column is rounded, and hovering a column lists every part and the
 * total. The legend names the parts; the figures also live in the table beside the chart.
 */
export function stackedColumns(canvas, labels, series, { currency = 'INR', totalLabel = 'Total' } = {}) {
  const t = themeTokens();
  Chart.defaults.font.family = FONT;
  Chart.defaults.font.size = 12;
  const value = (d, i) => Math.max(0, series[d]?.data[i] || 0);
  const topOf = (i) => {
    for (let d = series.length - 1; d >= 0; d--) if (value(d, i) > 0) return d;
    return -1;
  };
  const hasBelow = (d, i) => {
    for (let k = d - 1; k >= 0; k--) if (value(k, i) > 0) return true;
    return false;
  };
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((sr, d) => ({
        label: sr.label,
        data: sr.data.map((v) => (v > 0 ? v : 0)),
        backgroundColor: sr.color,
        stack: 'stack',
        maxBarThickness: 24,
        borderSkipped: false,
        borderColor: t.surface,
        borderWidth: (c) => (hasBelow(d, c.dataIndex) ? { bottom: 2 } : 0),
        borderRadius: (c) => (topOf(c.dataIndex) === d ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : 0),
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 8 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10, color: t.secondary, padding: 16 },
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
            label: (item) => {
              const sr = series[item.datasetIndex];
              const note = item.parsed.y > 0 ? null : sr.placeholder?.(item.dataIndex);
              return ` ${sr.label}: ${note || fmtMoney(item.parsed.y, currency)}`;
            },
            footer: (items) => `${totalLabel}: ${fmtMoney(items.reduce((sum, i) => sum + (i.parsed.y || 0), 0), currency)}`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { color: t.axis },
          ticks: { color: t.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: t.grid, lineWidth: 1, drawTicks: false },
          border: { display: false },
          grace: '5%',
          ticks: { color: t.muted, maxTicksLimit: 6, padding: 8, callback: (v) => fmtCompact(v, currency) },
        },
      },
    },
  });
  return chart;
}

/**
 * Ring ("donut") of one whole split into parts, e.g. current value by asset class.
 * parts: [{ label, value, color }] in a fixed order. The total sits in the hole; hovering a slice
 * shows its value and share. The list rendered beside it (names, amounts, shares) is the legend.
 */
export function donutChart(canvas, parts, { currency = 'INR', centreLabel = 'total' } = {}) {
  const t = themeTokens();
  const values = parts.map((p) => Math.max(0, p.value || 0));
  const total = values.reduce((s, v) => s + v, 0);
  const centreText = {
    id: 'centreText',
    afterDraw(chart) {
      const area = chart.chartArea;
      if (!area) return;
      const ctx = chart.ctx;
      const x = (area.left + area.right) / 2;
      const y = (area.top + area.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 18px ${FONT}`;
      ctx.fillStyle = t.ink;
      ctx.fillText(fmtCompact(total, currency), x, y - 9);
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = t.muted;
      ctx.fillText(centreLabel, x, y + 11);
      ctx.restore();
    },
  };
  Chart.defaults.font.family = FONT;
  Chart.defaults.font.size = 12;
  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: parts.map((p) => p.label),
      datasets: [
        {
          data: values,
          backgroundColor: parts.map((p) => p.color),
          hoverBackgroundColor: parts.map((p) => p.color),
          borderColor: t.surface, // a 2px surface gap between slices
          hoverBorderColor: t.surface,
          borderWidth: 2,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: '62%',
      layout: { padding: 8 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: t.surface,
          titleColor: t.ink,
          bodyColor: t.secondary,
          borderColor: t.axis,
          borderWidth: 1,
          padding: 10,
          usePointStyle: true,
          boxPadding: 4,
          callbacks: {
            label: (item) => ` ${item.label}: ${fmtMoney(item.parsed, currency)} (${total ? ((item.parsed / total) * 100).toFixed(1) : '0.0'}%)`,
          },
        },
      },
    },
    plugins: [centreText],
  });
}

/**
 * Thin segmented bar: one whole split into parts (e.g. redeemable vs locked value).
 * parts: [{ label, value, color }]. Returns HTML.
 */
export function segmentedBar(parts, { ariaLabel = '', currency = 'INR' } = {}) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value || 0), 0);
  if (!total) return '';
  const share = (v) => `${((v / total) * 100).toFixed(1)}%`;
  const segs = parts
    .filter((p) => p.value > 0)
    .map(
      (p) =>
        `<span class="seg" style="flex:${p.value} 1 0;background:${p.color}" title="${esc(p.label)}: ${fmtMoney(p.value, currency)} (${share(p.value)})"></span>`,
    )
    .join('');
  const legend = parts
    .map(
      (p) =>
        `<span class="legend-item"><i class="swatch" style="background:${p.color}"></i>${esc(p.label)} <b>${fmtMoney(p.value, currency)}</b> <span class="muted">${share(p.value || 0)}</span></span>`,
    )
    .join('');
  return `<div class="segbar" role="img" aria-label="${esc(ariaLabel)}">${segs}</div><div class="legend-row">${legend}</div>`;
}
