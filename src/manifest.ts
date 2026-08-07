/**
 * Typed manifest source of truth (IMPLEMENTATION_PLAN.md §5.3, §6/P1).
 *
 * Built to dist/manifest.json by scripts/build.mjs. Keeping this as TS
 * (instead of hand-edited JSON) means a typo in a permission/match-pattern
 * key is a type error at build time, not a silently-ignored key at runtime.
 *
 * host_permissions include our own FastAPI backend — required so the
 * service worker's fetches bypass CORS (§5.1).
 */

interface ContentScriptEntry {
  matches: string[];
  js: string[];
  world: 'ISOLATED' | 'MAIN';
  all_frames?: boolean;
  match_origin_as_fallback?: boolean;
  run_at?: 'document_start' | 'document_end' | 'document_idle';
}

interface TradePilotManifest {
  manifest_version: 3;
  name: string;
  version: string;
  description: string;
  minimum_chrome_version: string;
  action: {
    default_icon: Record<string, string>;
  };
  icons: Record<string, string>;
  permissions: string[];
  host_permissions: string[];
  background: {
    service_worker: string;
    type: 'module';
  };
  content_scripts: ContentScriptEntry[];
  side_panel: {
    default_path: string;
  };
  web_accessible_resources: Array<{ resources: string[]; matches: string[] }>;
}

// Our own backends — see IMPLEMENTATION_PLAN.md §10 Q3 and
// IMPLEMENTATION_PLAN_BACKEND_INTEGRATION.md §3. Two separate origins on
// purpose: 8000 is quantboard-pandapath (order placement / position-risk,
// still targeted directly there — see background/index.ts); 8100 is the
// isolated TradePilotBackend (on-chart chart-state/recommend polling plus
// the Strategies side panel). Both assume same-machine for now; revisit if
// either API ever runs on a different host.
const QUANTBOARD_API_ORIGIN = 'http://127.0.0.1:8000/*';
const TRADEPILOT_BACKEND_ORIGIN = 'http://127.0.0.1:8100/*';

const manifest: TradePilotManifest = {
  manifest_version: 3,
  name: 'TradePilot',
  version: '0.1.0',
  description:
    'On-chart trade widget for TradingView and Kotak Neo — suggested entry, TP/SL, one-click trade through your own wrapper API.',
  minimum_chrome_version: '111',
  action: {
    default_icon: {
      '16': 'icons/16.png',
      '32': 'icons/32.png',
      '48': 'icons/48.png',
      '128': 'icons/128.png',
    },
  },
  icons: {
    '16': 'icons/16.png',
    '32': 'icons/32.png',
    '48': 'icons/48.png',
    '128': 'icons/128.png',
  },
  // 'alarms' is P5's service-worker keepalive (background/index.ts) —
  // MV3 workers can be terminated after ~30s idle; a periodic alarm is
  // the documented way to get woken back up reliably.
  permissions: ['storage', 'scripting', 'activeTab', 'alarms', 'sidePanel'],
  host_permissions: [
    'https://*.tradingview.com/*',
    'https://*.kotaksecurities.com/*',
    'https://trade.kotakneo.com/*',
    QUANTBOARD_API_ORIGIN,
    TRADEPILOT_BACKEND_ORIGIN,
  ],
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  content_scripts: [
    // TradingView.com — same-document chart, no iframe nesting (§4.1).
    // Wildcarded subdomain (not just "www") because TradingView redirects
    // users to a regional subdomain based on locale — e.g. India-based
    // users land on in.tradingview.com, not www.tradingview.com, for the
    // exact same chart app. host_permissions above already wildcarded this;
    // matches here didn't, so the content script silently never injected
    // at all on any non-"www" regional subdomain (no error — Chrome just
    // never runs a script outside its declared matches).
    {
      matches: ['https://*.tradingview.com/chart/*'],
      world: 'ISOLATED',
      js: ['content.js'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://*.tradingview.com/chart/*'],
      world: 'MAIN',
      js: ['bridge.js'],
      run_at: 'document_idle',
    },
    // Kotak Neo — chart lives in a nested blob: iframe (§4.2). Both scripts
    // must target it directly; all_frames + match_origin_as_fallback are
    // the two documented MV3 mechanisms for reaching a blob:-scheme frame
    // keyed on its creating origin. Wiring/verification is P7 — declared
    // here now so P1's manifest matches the plan's final shape, but not
    // exercised until P7 confirms the content script actually lands in the
    // innermost frame rather than the middle static-HTML one.
    {
      matches: ['https://trade.kotakneo.com/*'],
      all_frames: true,
      match_origin_as_fallback: true,
      world: 'ISOLATED',
      js: ['content.js'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://trade.kotakneo.com/*'],
      all_frames: true,
      match_origin_as_fallback: true,
      world: 'MAIN',
      js: ['bridge.js'],
      run_at: 'document_idle',
    },
  ],
  side_panel: {
    default_path: 'sidepanel.html',
  },
  // ShadowHost fetches these at runtime via chrome.runtime.getURL (§P3) — that
  // fetch carries the host page's origin as initiator, so without this
  // declaration Chrome blocks it and the widget silently renders unstyled.
  web_accessible_resources: [
    {
      resources: ['styles/*.css'],
      matches: [
        'https://*.tradingview.com/*',
        'https://trade.kotakneo.com/*',
        'https://*.kotaksecurities.com/*',
      ],
    },
  ],
};

export default manifest;
