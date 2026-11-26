// Monochrome outline icons (currentColor).
'use strict';
const I = (() => {
  const s = (d, w = 1.7) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  return {
    server: s('<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01" stroke-width="2.4"/>'),
    chart: s('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M7 14.5l3-3.5 3 2.5 4-5"/>'),
    cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9.5 14.5v-5h5"/><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/></svg>',
    memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V6a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v7h-1"/><path d="M3 9h16a1 1 0 0 1 1 1v7H2v-7a1 1 0 0 1 1-1z"/><path d="M5 12h3v2H5zM10 12h3v2h-3zM15 12h2v2h-2z"/><path d="M4 17v2M6 17v2M8 17v2M10 17v2M14 17v2M16 17v2M18 17v2"/></svg>',
    shield: s('<path d="M12 3l7.5 3v5.5c0 4.5-3.1 8.2-7.5 9.5-4.4-1.3-7.5-5-7.5-9.5V6z"/><path d="M8.8 12l2.2 2.2 4.3-4.4"/>'),
    shieldx: s('<path d="M12 3l7.5 3v5.5c0 4.5-3.1 8.2-7.5 9.5-4.4-1.3-7.5-5-7.5-9.5V6z"/><path d="M12 8v4.5M12 16h.01" stroke-width="2"/>'),
    check: s('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>'),
    alert: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2h.01" stroke-width="2"/>'),
    clock: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/>'),
    play: s('<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.8v6.4l5.3-3.2z"/>'),
    save: s('<path d="M5 4.5h11l3 3V18a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18z"/><path d="M8.5 4.5v4h6v-4M8 19.5v-5.5h8v5.5"/>'),
    power: s('<path d="M12 3.5v8"/><path d="M7.2 6.6a7 7 0 1 0 9.6 0"/>', 2),
    restart: s('<path d="M19.5 8.5A8 8 0 0 0 5 9"/><path d="M19.5 4v4.5H15"/><path d="M4.5 15.5A8 8 0 0 0 19 15"/><path d="M4.5 20v-4.5H9"/>'),
    backup: s('<ellipse cx="11" cy="6" rx="6.5" ry="2.5"/><path d="M4.5 6v5.5c0 1.4 2.9 2.5 6.5 2.5M17.5 6v3.5"/><path d="M4.5 11.5V17c0 1.4 2.9 2.5 6.5 2.5"/><path d="M14.5 17a3.5 3.5 0 1 0 1-2.5M14.5 12.5v2.5H17"/>'),
    checkmark: s('<path d="M5.5 12.5l4.2 4.2L18.5 8"/>', 2.2),
    chevron: s('<path d="M7 10l5 5 5-5"/>', 1.8),
    back: s('<path d="M15 5.5L8.5 12l6.5 6.5"/>', 2),
  };
})();
