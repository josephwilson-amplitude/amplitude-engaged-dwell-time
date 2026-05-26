/**
 * Amplitude Browser SDK - Engaged Dwell Time Plugin
 *
 * Tracks only the time a user was actively engaged on a page,
 * filtering out idle periods (e.g. leaving for coffee with the tab open).
 *
 * Engagement is defined as: any activity signal within the last
 * `inactivityThreshold` milliseconds while the tab is visible.
 *
 * Fires a single `[Engaged Dwell] Page Exit` event on page exit containing:
 *   - engaged_time_ms   : ms the user was actively engaged
 *   - total_time_ms     : raw dwell time (for comparison)
 *   - engaged_ratio     : 0–1 fraction of time that was engaged
 *   - page_url / page_title
 *
 * Usage:
 *   const plugin = createEngagedDwellTimePlugin({ inactivityThreshold: 30_000 });
 *   amplitude.add(plugin);
 *
 * SPA navigation reset:
 *   plugin.reset();  // call on each route change
 *
 * Live reads (for dashboards / debugging):
 *   plugin.getEngagedTimeMs()
 *   plugin.getTotalTimeMs()
 *   plugin.isEngaged()
 */
const createEngagedDwellTimePlugin = (options = {}) => {
  const {
    inactivityThreshold = 30_000,
    tickInterval       = 1_000,
    throttleMs         = 500,
    activityEvents     = ['mousemove', 'scroll', 'keydown', 'click', 'touchstart', 'wheel'],
  } = options;

  let amplitudeInstance = null;
  let pageEntryTime     = Date.now();
  let lastActivityTime  = Date.now(); // assume engaged on arrival
  let lastThrottleTime  = 0;
  let lastTickTime      = Date.now();
  let engagedTimeMs     = 0;
  let tickTimer         = null;
  let hasFired          = false;

  // ─── Activity detection ────────────────────────────────────────────────────

  const onActivity = () => {
    const now = Date.now();
    if (now - lastThrottleTime < throttleMs) return;
    lastThrottleTime = now;
    lastActivityTime = now;
  };

  // ─── Accumulator tick ─────────────────────────────────────────────────────
  // Runs every `tickInterval` ms. Adds elapsed time to engagedTimeMs only
  // when the user has been active recently AND the tab is visible.

  const tick = () => {
    const now               = Date.now();
    const delta             = now - lastTickTime;
    lastTickTime            = now;
    const timeSinceActivity = now - lastActivityTime;

    // Only accumulate when the user has been active recently.
    // Tab-visibility is handled separately: visibilitychange fires the summary
    // event when the tab hides, and activity signals naturally stop arriving
    // in a hidden tab so the user goes idle after inactivityThreshold anyway.
    if (timeSinceActivity < inactivityThreshold) {
      engagedTimeMs += delta;
    }
  };

  // ─── Page exit event ──────────────────────────────────────────────────────
  // Deduplicated — the three exit signals (visibilitychange, pagehide,
  // beforeunload) can fire together; hasFired ensures only one event is sent.

  const fireSummaryEvent = () => {
    if (hasFired || !amplitudeInstance) return;
    hasFired = true;

    clearInterval(tickTimer);
    tick(); // capture any remaining partial-second engagement

    const totalTimeMs  = Date.now() - pageEntryTime;
    const engagedRatio = totalTimeMs > 0
      ? Math.round((engagedTimeMs / totalTimeMs) * 100) / 100
      : 0;

    amplitudeInstance.track('[Engaged Dwell] Page Exit', {
      engaged_time_ms:        Math.round(engagedTimeMs),
      total_time_ms:          Math.round(totalTimeMs),
      engaged_ratio:          engagedRatio,
      page_url:               location.href,
      page_title:             document.title,
      inactivity_threshold_ms: inactivityThreshold,
    });

    amplitudeInstance.flush();
  };

  // ─── Plugin interface ──────────────────────────────────────────────────────

  return {
    name: 'engaged-dwell-time',
    type: 'enrichment',

    setup: async (_config, instance) => {
      amplitudeInstance = instance;
      pageEntryTime    = Date.now();
      lastActivityTime = Date.now();
      lastTickTime     = Date.now();
      hasFired         = false;

      activityEvents.forEach(name => {
        window.addEventListener(name, onActivity, { passive: true });
      });

      // visibilitychange is the primary signal on mobile (tab backgrounded)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') fireSummaryEvent();
      });

      // pagehide is more reliable than beforeunload for back/forward cache
      window.addEventListener('pagehide', fireSummaryEvent);

      // beforeunload catches desktop close/refresh missed by pagehide
      window.addEventListener('beforeunload', fireSummaryEvent);

      tickTimer = setInterval(tick, tickInterval);
    },

    // Pass-through — this plugin only fires its own exit event, it does not
    // enrich other Amplitude events.
    execute: async (event) => event,

    teardown: async () => {
      clearInterval(tickTimer);
      activityEvents.forEach(name => {
        window.removeEventListener(name, onActivity);
      });
    },

    // ── Public API ────────────────────────────────────────────────────────────

    // Call on SPA route changes to start a fresh page measurement.
    reset() {
      clearInterval(tickTimer);
      engagedTimeMs    = 0;
      pageEntryTime    = Date.now();
      lastActivityTime = Date.now();
      lastTickTime     = Date.now();
      hasFired         = false;
      tickTimer        = setInterval(tick, tickInterval);
    },

    // Live reads for debugging / UI overlays.
    getEngagedTimeMs: () => Math.round(engagedTimeMs),
    getTotalTimeMs:   () => Math.round(Date.now() - pageEntryTime),
    isEngaged:        () => (Date.now() - lastActivityTime) < inactivityThreshold
                            && document.visibilityState === 'visible',
  };
};
