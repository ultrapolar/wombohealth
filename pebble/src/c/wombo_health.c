// Wombo Health — Pebble watchapp for the trmnl-health Cloudflare Worker.
//
// Styled after PebbleOS's built-in Health app (coredevices/PebbleOS,
// src/fw/apps/system/health) so it can take over the watchface's "Tap Up"
// quick-launch slot: full-screen summary cards that slide vertically with a
// moook-style overshoot, UP goes deeper, DOWN below the first card exits to
// the watchface, SELECT opens a detail view. Data arrives pre-formatted from
// the phone-side JS (src/pkjs/index.js), which polls the Worker's flat
// display payload (GET /?key=…, the same one TRMNL renders).

#include <pebble.h>

#define VAL_LEN 20

// ---------------------------------------------------------------------------
// State (mirrors the worker payload; persisted so launch feels instant)

typedef struct {
  char sleep_score[VAL_LEN], sleep_dur[VAL_LEN], sleep_deep[VAL_LEN],
      sleep_rem[VAL_LEN], sleep_cycles[VAL_LEN];
  char recovery[VAL_LEN], hrv[VAL_LEN], rhr[VAL_LEN], spo2[VAL_LEN], temp[VAL_LEN];
  char steps[VAL_LEN], active[VAL_LEN], move[VAL_LEN], vo2[VAL_LEN];
  char aqi[VAL_LEN], co2[VAL_LEN], pm25[VAL_LEN], home_temp[VAL_LEN],
      humidity[VAL_LEN], noise[VAL_LEN];
  char weight[VAL_LEN], fat[VAL_LEN], muscle[VAL_LEN], water[VAL_LEN], measured[VAL_LEN];
  char updated[VAL_LEN];
  int32_t steps_num, steps_pct, typical_pct, sleep_min, rhr_num, hrv_num, hrv_trend;
  bool home_enabled, body_present, stale;
} AppState;

static AppState s_state;
static bool s_have_data;
static char s_status[80] = "Syncing...";

// Persist the whole struct in <=200-byte chunks (persist values are capped).
#define PERSIST_VERSION_KEY 100
#define PERSIST_VERSION 2
#define PERSIST_CHUNK_KEY 101
#define PERSIST_CHUNK 200

static void prv_state_save(void) {
  persist_write_int(PERSIST_VERSION_KEY, PERSIST_VERSION);
  const uint8_t *p = (const uint8_t *)&s_state;
  for (uint32_t off = 0, i = 0; off < sizeof(AppState); off += PERSIST_CHUNK, i++) {
    uint32_t n = sizeof(AppState) - off;
    if (n > PERSIST_CHUNK) n = PERSIST_CHUNK;
    persist_write_data(PERSIST_CHUNK_KEY + i, p + off, n);
  }
}

static bool prv_state_load(void) {
  if (persist_read_int(PERSIST_VERSION_KEY) != PERSIST_VERSION) return false;
  uint8_t *p = (uint8_t *)&s_state;
  for (uint32_t off = 0, i = 0; off < sizeof(AppState); off += PERSIST_CHUNK, i++) {
    uint32_t n = sizeof(AppState) - off;
    if (n > PERSIST_CHUNK) n = PERSIST_CHUNK;
    if (persist_read_data(PERSIST_CHUNK_KEY + i, p + off, n) != (int)n) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cards

typedef enum {
  CardActivity,
  CardHeart,
  CardSleep,
  CardAir,
  CardBody,
  CARD_TYPE_COUNT,
} CardType;

static CardType s_cards[CARD_TYPE_COUNT];
static int s_ncards;
static int s_card;  // index into s_cards

static Window *s_window;
static Layer *s_card_layers[CARD_TYPE_COUNT];  // indexed like s_cards
static Layer *s_chrome_layer;                  // arrows + select dot, above cards
static Animation *s_slide_anim;
static int32_t s_reveal = 1000;  // 0..1000, scales count-ups and ring sweeps
static int s_pulse_phase;
static AppTimer *s_pulse_timer;

static GColor prv_card_bg(CardType t) {
  switch (t) {
    case CardActivity: return PBL_IF_COLOR_ELSE(GColorBlack, GColorBlack);
    case CardHeart:    return GColorWhite;
    case CardSleep:    return PBL_IF_COLOR_ELSE(GColorOxfordBlue, GColorBlack);
    case CardAir:      return PBL_IF_COLOR_ELSE(GColorMidnightGreen, GColorWhite);
    case CardBody:     return PBL_IF_COLOR_ELSE(GColorImperialPurple, GColorWhite);
    default:           return GColorBlack;
  }
}

static void prv_rebuild_cards(void) {
  s_ncards = 0;
  s_cards[s_ncards++] = CardActivity;
  s_cards[s_ncards++] = CardHeart;
  s_cards[s_ncards++] = CardSleep;
  if (s_state.home_enabled) s_cards[s_ncards++] = CardAir;
  if (s_state.body_present) s_cards[s_ncards++] = CardBody;
  if (s_card >= s_ncards) s_card = 0;
}

// ---------------------------------------------------------------------------
// Drawing helpers

static bool prv_is_leco_safe(const char *s) {
  if (!s[0]) return false;
  for (const char *c = s; *c; c++) {
    if (!((*c >= '0' && *c <= '9') || *c == ':' || *c == '-')) return false;
  }
  return true;
}

// Big centered number: LECO when it's digits-only, Gothic otherwise.
static void prv_draw_big(GContext *ctx, GRect box, const char *text, GColor color) {
  graphics_context_set_text_color(ctx, color);
  GFont font = prv_is_leco_safe(text)
      ? fonts_get_system_font(FONT_KEY_LECO_36_BOLD_NUMBERS)
      : fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
  graphics_draw_text(ctx, text[0] ? text : "--", font, box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void prv_draw_label(GContext *ctx, GRect box, const char *text, GColor color) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(box.origin.x, box.origin.y, box.size.w, 18),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

// The system app's "TYPICAL n" box: outlined rounded rect, label + value.
static void prv_draw_typical_box(GContext *ctx, GRect bounds, const char *label,
                                 const char *value, GColor fg) {
  const int w = bounds.size.w - PBL_IF_ROUND_ELSE(72, 44);
  GRect box = GRect((bounds.size.w - w) / 2, bounds.size.h - PBL_IF_ROUND_ELSE(46, 40), w, 30);
  graphics_context_set_stroke_color(ctx, fg);
  graphics_draw_round_rect(ctx, box, 4);
  char buf[36];
  snprintf(buf, sizeof(buf), "%s %s", label, value[0] ? value : "--");
  graphics_context_set_text_color(ctx, fg);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(box.origin.x, box.origin.y + 1, box.size.w, box.size.h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void prv_draw_stale(GContext *ctx, GRect bounds, GColor fg) {
  if (!s_state.stale) return;
  graphics_context_set_text_color(ctx, fg);
  graphics_draw_text(ctx, "stale", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(0, 0, bounds.size.w - PBL_IF_ROUND_ELSE(26, 6), 16),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}

// ---------------------------------------------------------------------------
// Card update procs

static void prv_activity_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const GColor green = PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorWhite);
  const GColor track = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorLightGray);

  // Progress ring around the footprint icon, like the system app's hexagon:
  // green fill = today's % of step goal, yellow mark = typical (week average).
  const int ring_d = b.size.h * 5 / 11;
  GRect ring = GRect((b.size.w - ring_d) / 2, PBL_IF_ROUND_ELSE(18, 10), ring_d, ring_d);
  const int thick = 7;
  graphics_context_set_fill_color(ctx, track);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, thick, 0, TRIG_MAX_ANGLE);
  int pct = (int)(s_state.steps_pct * s_reveal / 1000);
  if (pct > 100) pct = 100;
  if (pct > 0) {
    graphics_context_set_fill_color(ctx, green);
    graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, thick, 0,
                         TRIG_MAX_ANGLE * pct / 100);
  }
  if (s_state.typical_pct > 0 && s_state.typical_pct <= 100) {
    int32_t a = TRIG_MAX_ANGLE * s_state.typical_pct / 100;
    graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorYellow, GColorWhite));
    graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, thick + 2,
                         a - TRIG_MAX_ANGLE / 90, a + TRIG_MAX_ANGLE / 90);
  }

  // Footprint icon: sole + heel + three toes.
  GPoint c = GPoint(ring.origin.x + ring_d / 2, ring.origin.y + ring_d / 2);
  graphics_context_set_fill_color(ctx, green);
  graphics_fill_rect(ctx, GRect(c.x - 7, c.y - 14, 14, 18), 7, GCornersAll);
  graphics_fill_circle(ctx, GPoint(c.x, c.y + 10), 5);
  graphics_fill_circle(ctx, GPoint(c.x - 8, c.y - 16), 2);
  graphics_fill_circle(ctx, GPoint(c.x - 1, c.y - 19), 2);
  graphics_fill_circle(ctx, GPoint(c.x + 6, c.y - 17), 2);

  // Count-up steps, LECO like the system app.
  char buf[12];
  long shown = (long)(s_state.steps_num * s_reveal / 1000);
  if (s_state.steps_num > 0) {
    snprintf(buf, sizeof(buf), "%ld", shown);
  } else {
    snprintf(buf, sizeof(buf), "--");
  }
  prv_draw_big(ctx, GRect(0, ring.origin.y + ring_d - 2, b.size.w, 44), buf, green);

  char typ[12];
  snprintf(typ, sizeof(typ), "%ld%%", (long)s_state.typical_pct);
  prv_draw_typical_box(ctx, b, "TYPICAL", s_state.typical_pct ? typ : "--", GColorWhite);
  prv_draw_stale(ctx, b, track);
}

// Heartbeat lub-dub: radius bump per animation frame (~70ms each).
static const int8_t PULSE[16] = {0, 2, 5, 8, 4, 1, 3, 6, 3, 1, 0, 0, 0, 0, 0, 0};

// The heart card redraws every pulse tick, so its paths are allocated once
// and mutated in place — per-frame gpath_create/destroy churns the heap.
static GPoint s_heart_tri_points[3];
static GPath *s_heart_tri;
static GPoint s_trend_tri_points[3];
static GPath *s_trend_tri;

static void prv_draw_heart(GContext *ctx, GPoint c, int r, GColor color) {
  graphics_context_set_fill_color(ctx, color);
  // Two lobes + a triangle point.
  graphics_fill_circle(ctx, GPoint(c.x - r / 2, c.y - r / 3), r / 2 + 1);
  graphics_fill_circle(ctx, GPoint(c.x + r / 2, c.y - r / 3), r / 2 + 1);
  s_heart_tri_points[0] = GPoint(c.x - r, c.y - r / 4);
  s_heart_tri_points[1] = GPoint(c.x + r, c.y - r / 4);
  s_heart_tri_points[2] = GPoint(c.x, c.y + r);
  gpath_draw_filled(ctx, s_heart_tri);
}

static void prv_heart_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const GColor red = PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);

  prv_draw_heart(ctx, GPoint(b.size.w / 2, PBL_IF_ROUND_ELSE(46, 38)),
                 16 + PULSE[s_pulse_phase], red);

  char buf[12];
  long shown = (long)(s_state.rhr_num * s_reveal / 1000);
  if (s_state.rhr_num > 0) {
    snprintf(buf, sizeof(buf), "%ld", shown);
  } else {
    snprintf(buf, sizeof(buf), "--");
  }
  prv_draw_big(ctx, GRect(0, b.size.h / 2 - 14, b.size.w, 44), buf, GColorBlack);
  prv_draw_label(ctx, GRect(0, b.size.h / 2 + 26, b.size.w, 18), "RESTING BPM",
                 PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));

  // HRV with a little trend triangle, system "typical box" styling.
  char hrv[16];
  if (s_state.hrv_num > 0) {
    snprintf(hrv, sizeof(hrv), "%ld", (long)s_state.hrv_num);
  } else {
    snprintf(hrv, sizeof(hrv), "--");
  }
  prv_draw_typical_box(ctx, b, "HRV", hrv, GColorBlack);
  if (s_state.hrv_trend != 0 && s_state.hrv_num > 0) {
    const int w = b.size.w - PBL_IF_ROUND_ELSE(72, 44);
    GPoint t = GPoint((b.size.w + w) / 2 - 14, b.size.h - PBL_IF_ROUND_ELSE(46, 40) + 15);
    const int up = (s_state.hrv_trend > 0) ? -1 : 1;
    s_trend_tri_points[0] = GPoint(t.x - 4, t.y - 3 * up);
    s_trend_tri_points[1] = GPoint(t.x + 4, t.y - 3 * up);
    s_trend_tri_points[2] = GPoint(t.x, t.y + 4 * up);
    graphics_context_set_fill_color(ctx, s_state.hrv_trend > 0
        ? PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack)
        : PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
    gpath_draw_filled(ctx, s_trend_tri);
  }
  prv_draw_stale(ctx, b, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
}

static void prv_sleep_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const GColor blue = PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorWhite);

  // Crescent moon: circle with a bite of background color.
  GPoint m = GPoint(b.size.w / 2, PBL_IF_ROUND_ELSE(46, 38));
  graphics_context_set_fill_color(ctx, blue);
  graphics_fill_circle(ctx, m, 17);
  graphics_context_set_fill_color(ctx, prv_card_bg(CardSleep));
  graphics_fill_circle(ctx, GPoint(m.x + 9, m.y - 7), 14);

  // Big H:MM, counted up.
  char buf[12];
  long mins = (long)(s_state.sleep_min * s_reveal / 1000);
  if (s_state.sleep_min > 0) {
    snprintf(buf, sizeof(buf), "%ld:%02ld", mins / 60, mins % 60);
  } else {
    snprintf(buf, sizeof(buf), "--");
  }
  prv_draw_big(ctx, GRect(0, b.size.h / 2 - 14, b.size.w, 44), buf, blue);
  prv_draw_label(ctx, GRect(0, b.size.h / 2 + 26, b.size.w, 18), "TIME ASLEEP",
                 PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));

  prv_draw_typical_box(ctx, b, "SCORE", s_state.sleep_score, GColorWhite);
  prv_draw_stale(ctx, b, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
}

static void prv_air_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const GColor fg = PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack);

  // A puffy little cloud.
  GPoint c = GPoint(b.size.w / 2, PBL_IF_ROUND_ELSE(46, 38));
  graphics_context_set_fill_color(ctx, fg);
  graphics_fill_circle(ctx, GPoint(c.x - 10, c.y + 2), 8);
  graphics_fill_circle(ctx, GPoint(c.x + 2, c.y - 4), 11);
  graphics_fill_circle(ctx, GPoint(c.x + 13, c.y + 3), 7);
  graphics_fill_rect(ctx, GRect(c.x - 10, c.y + 2, 24, 8), 0, GCornerNone);

  prv_draw_big(ctx, GRect(0, b.size.h / 2 - 14, b.size.w, 44), s_state.aqi, fg);
  prv_draw_label(ctx, GRect(0, b.size.h / 2 + 26, b.size.w, 18), "AQI",
                 PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));

  prv_draw_typical_box(ctx, b, "CO2", s_state.co2, fg);
  prv_draw_stale(ctx, b, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
}

static void prv_body_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const GColor fg = PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack);

  // A bathroom scale: rounded square with a dial notch.
  GPoint c = GPoint(b.size.w / 2, PBL_IF_ROUND_ELSE(46, 38));
  graphics_context_set_fill_color(ctx, fg);
  graphics_fill_rect(ctx, GRect(c.x - 15, c.y - 14, 30, 30), 6, GCornersAll);
  graphics_context_set_fill_color(ctx, prv_card_bg(CardBody));
  graphics_fill_circle(ctx, GPoint(c.x, c.y - 4), 6);
  graphics_context_set_stroke_color(ctx, fg);
  graphics_draw_line(ctx, GPoint(c.x, c.y - 4), GPoint(c.x + 3, c.y - 8));

  prv_draw_big(ctx, GRect(0, b.size.h / 2 - 14, b.size.w, 44), s_state.weight, fg);
  prv_draw_label(ctx, GRect(0, b.size.h / 2 + 26, b.size.w, 18), "WEIGHT",
                 PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));

  prv_draw_typical_box(ctx, b, "FAT", s_state.fat, fg);
  prv_draw_stale(ctx, b, PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack));
}

static const LayerUpdateProc CARD_UPDATE_PROCS[CARD_TYPE_COUNT] = {
  [CardActivity] = prv_activity_update,
  [CardHeart] = prv_heart_update,
  [CardSleep] = prv_sleep_update,
  [CardAir] = prv_air_update,
  [CardBody] = prv_body_update,
};

// ---------------------------------------------------------------------------
// Chrome: up/down arrows + select dot (content/action indicators)

static void prv_chrome_update(Layer *layer, GContext *ctx) {
  if (!s_have_data) return;
  GRect b = layer_get_bounds(layer);
  GColor bg = prv_card_bg(s_cards[s_card]);
  GColor fg = gcolor_legible_over(bg);
  graphics_context_set_fill_color(ctx, fg);

  if (s_card + 1 < s_ncards) {  // more cards above (UP goes deeper)
    GPathInfo up = {.num_points = 3, .points = (GPoint[]){
        {(int16_t)(b.size.w / 2 - 6), 6}, {(int16_t)(b.size.w / 2 + 6), 6},
        {(int16_t)(b.size.w / 2), 1}}};
    GPath *p = gpath_create(&up);
    gpath_draw_filled(ctx, p);
    gpath_destroy(p);
  }
  // DOWN always available: previous card or back to the watchface.
  GPathInfo dn = {.num_points = 3, .points = (GPoint[]){
      {(int16_t)(b.size.w / 2 - 6), (int16_t)(b.size.h - 7)},
      {(int16_t)(b.size.w / 2 + 6), (int16_t)(b.size.h - 7)},
      {(int16_t)(b.size.w / 2), (int16_t)(b.size.h - 2)}}};
  GPath *p = gpath_create(&dn);
  gpath_draw_filled(ctx, p);
  gpath_destroy(p);

  // Select indicator dot on the right edge.
  graphics_fill_circle(ctx, GPoint(b.size.w - 4, b.size.h / 2), 3);
}

// ---------------------------------------------------------------------------
// Reveal animation (count-ups + ring sweep)

static void prv_reveal_update(Animation *anim, AnimationProgress progress) {
  s_reveal = 1000 * progress / ANIMATION_NORMALIZED_MAX;
  if (s_card_layers[s_card]) layer_mark_dirty(s_card_layers[s_card]);
}

static const AnimationImplementation REVEAL_IMPL = {.update = prv_reveal_update};

static void prv_start_reveal(void) {
  Animation *anim = animation_create();
  if (!anim) return;
  animation_set_duration(anim, 700);
  animation_set_curve(anim, AnimationCurveEaseOut);
  animation_set_implementation(anim, &REVEAL_IMPL);
  animation_schedule(anim);
}

// ---------------------------------------------------------------------------
// Heartbeat pulse (only while the heart card is showing)

static void prv_pulse_tick(void *context) {
  s_pulse_timer = NULL;
  if (!s_have_data || s_cards[s_card] != CardHeart) return;
  s_pulse_phase = (s_pulse_phase + 1) % 16;
  layer_mark_dirty(s_card_layers[s_card]);
  s_pulse_timer = app_timer_register(70, prv_pulse_tick, NULL);
}

static void prv_pulse_ensure(void) {
  if (s_have_data && s_cards[s_card] == CardHeart && !s_pulse_timer) {
    s_pulse_timer = app_timer_register(70, prv_pulse_tick, NULL);
  }
}

// ---------------------------------------------------------------------------
// Card slide with moook-style overshoot (the system app's signature feel)

static AnimationProgress prv_moook_curve(AnimationProgress p) {
  const int64_t max = ANIMATION_NORMALIZED_MAX;
  const int64_t over = max * 6 / 100;   // ~6% overshoot, snaps back
  const int64_t t1 = max * 65 / 100;
  if (p < t1) {
    return (AnimationProgress)((max + over) * p * p / (t1 * t1));
  }
  const int64_t x = p - t1;
  const int64_t rem = max - t1;
  const int64_t s = x * (2 * rem - x);  // ease-out parabola
  return (AnimationProgress)(max + over - over * s / (rem * rem));
}

static void prv_slide_stopped(Animation *anim, bool finished, void *context) {
  for (int i = 0; i < s_ncards; i++) {
    layer_set_hidden(s_card_layers[i], i != s_card);
  }
  layer_mark_dirty(s_chrome_layer);
  prv_pulse_ensure();
}

static void prv_slide_to_card(int next, bool slide_up) {
  animation_unschedule(s_slide_anim);
  s_slide_anim = NULL;

  GRect bounds = layer_get_bounds(window_get_root_layer(s_window));
  Layer *cur = s_card_layers[s_card];
  Layer *nxt = s_card_layers[next];

  GRect cur_stop = bounds;
  cur_stop.origin.y = slide_up ? bounds.size.h : -bounds.size.h;
  GRect nxt_start = bounds;
  nxt_start.origin.y = slide_up ? -bounds.size.h : bounds.size.h;

  layer_set_frame(nxt, nxt_start);
  layer_set_hidden(nxt, false);

  PropertyAnimation *out = property_animation_create_layer_frame(cur, &bounds, &cur_stop);
  PropertyAnimation *in = property_animation_create_layer_frame(nxt, &nxt_start, &bounds);
  if (!out || !in) {  // OOM fallback: jump cut
    if (out) property_animation_destroy(out);
    if (in) property_animation_destroy(in);
    layer_set_frame(nxt, bounds);
    s_card = next;
    window_set_background_color(s_window, prv_card_bg(s_cards[s_card]));
    prv_slide_stopped(NULL, true, NULL);
    return;
  }
  Animation *a_out = property_animation_get_animation(out);
  Animation *a_in = property_animation_get_animation(in);
  animation_set_duration(a_out, 360);
  animation_set_duration(a_in, 360);
  animation_set_custom_curve(a_out, prv_moook_curve);
  animation_set_custom_curve(a_in, prv_moook_curve);

  s_card = next;
  window_set_background_color(s_window, prv_card_bg(s_cards[s_card]));

  s_slide_anim = animation_spawn_create(a_out, a_in, NULL);
  animation_set_handlers(s_slide_anim, (AnimationHandlers){.stopped = prv_slide_stopped}, NULL);
  animation_schedule(s_slide_anim);
}

// ---------------------------------------------------------------------------
// Detail window (SELECT, like the system app's detail cards)

typedef struct {
  const char *label;
  const char *value;
} DetailRow;

static Window *s_detail_window;
static Layer *s_detail_layer;
static DetailRow s_detail_rows[7];
static int s_detail_nrows;
static const char *s_detail_title;
static GColor s_detail_accent;

static void prv_detail_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const int inset = PBL_IF_ROUND_ELSE(26, 6);

  const int bar_h = 26;
  graphics_context_set_fill_color(ctx, s_detail_accent);
  graphics_fill_rect(ctx, GRect(0, 0, b.size.w, bar_h), 0, GCornerNone);
  graphics_context_set_text_color(ctx, gcolor_legible_over(s_detail_accent));
  graphics_draw_text(ctx, s_detail_title, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(0, -2, b.size.w, bar_h), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);

  const int footer_h = 18;
  const int label_w = 70;
  int row_h = (b.size.h - bar_h - footer_h) / s_detail_nrows;
  graphics_context_set_text_color(ctx, GColorBlack);
  for (int i = 0; i < s_detail_nrows; i++) {
    int y = bar_h + i * row_h + (row_h - 22) / 2;
    graphics_draw_text(ctx, s_detail_rows[i].label, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(inset, y + 3, label_w, row_h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    const char *v = s_detail_rows[i].value[0] ? s_detail_rows[i].value : "--";
    graphics_draw_text(ctx, v, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       GRect(inset + label_w, y, b.size.w - 2 * inset - label_w, row_h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  }

  char footer[32];
  if (s_state.stale) {
    snprintf(footer, sizeof(footer), "upd %s (stale)", s_state.updated);
  } else {
    snprintf(footer, sizeof(footer), "upd %s", s_state.updated);
  }
  graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  graphics_draw_text(ctx, footer, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(0, b.size.h - footer_h - 2, b.size.w, footer_h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void prv_detail_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_detail_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_detail_layer, prv_detail_update);
  layer_add_child(root, s_detail_layer);
}

static void prv_detail_unload(Window *window) {
  layer_destroy(s_detail_layer);
  window_destroy(s_detail_window);
  s_detail_window = NULL;
}

static void prv_show_detail(void) {
  if (!s_have_data) return;
  s_detail_nrows = 0;
#define ROW(l, v) (s_detail_rows[s_detail_nrows++] = (DetailRow){(l), (v)})
  switch (s_cards[s_card]) {
    case CardActivity:
      s_detail_title = "Activity";
      ROW("Steps", s_state.steps);
      ROW("Active", s_state.active);
      ROW("Movement", s_state.move);
      ROW("VO2 max", s_state.vo2);
      break;
    case CardHeart:
      s_detail_title = "Heart";
      ROW("HRV", s_state.hrv);
      ROW("RHR", s_state.rhr);
      ROW("SpO2", s_state.spo2);
      ROW("Skin temp", s_state.temp);
      ROW("Recovery", s_state.recovery);
      break;
    case CardSleep:
      s_detail_title = "Sleep";
      ROW("Score", s_state.sleep_score);
      ROW("Duration", s_state.sleep_dur);
      ROW("Deep", s_state.sleep_deep);
      ROW("REM", s_state.sleep_rem);
      ROW("Cycles", s_state.sleep_cycles);
      break;
    case CardAir:
      s_detail_title = "Air";
      ROW("AQI", s_state.aqi);
      ROW("CO2", s_state.co2);
      ROW("PM2.5", s_state.pm25);
      ROW("Temp", s_state.home_temp);
      ROW("Humidity", s_state.humidity);
      ROW("Noise", s_state.noise);
      break;
    case CardBody:
      s_detail_title = "Body";
      ROW("Weight", s_state.weight);
      ROW("Body fat", s_state.fat);
      ROW("Muscle", s_state.muscle);
      ROW("Water", s_state.water);
      ROW("Measured", s_state.measured);
      break;
    default:
      return;
  }
#undef ROW
  s_detail_accent = PBL_IF_COLOR_ELSE(prv_card_bg(s_cards[s_card]), GColorBlack);
  if (gcolor_equal(s_detail_accent, GColorWhite)) s_detail_accent = GColorBlack;
  s_detail_window = window_create();
  window_set_background_color(s_detail_window, GColorWhite);
  window_set_window_handlers(s_detail_window, (WindowHandlers){
    .load = prv_detail_load,
    .unload = prv_detail_unload,
  });
  window_stack_push(s_detail_window, true);
}

// ---------------------------------------------------------------------------
// AppMessage

static void prv_copy_str(DictionaryIterator *it, uint32_t key, char *buf, size_t len) {
  Tuple *t = dict_find(it, key);
  if (t && t->type == TUPLE_CSTRING) {
    strncpy(buf, t->value->cstring, len - 1);
    buf[len - 1] = '\0';
  }
}

static int32_t prv_get_int(DictionaryIterator *it, uint32_t key, int32_t fallback) {
  Tuple *t = dict_find(it, key);
  return t ? t->value->int32 : fallback;
}

static void prv_inbox_received(DictionaryIterator *it, void *context) {
  Tuple *err = dict_find(it, MESSAGE_KEY_ERROR);
  if (err && err->type == TUPLE_CSTRING && err->length > 1) {
    if (!s_have_data) {  // keep showing persisted data on transient errors
      snprintf(s_status, sizeof(s_status), "%s", err->value->cstring);
      layer_mark_dirty(window_get_root_layer(s_window));
    }
    return;
  }

  AppState *s = &s_state;
  prv_copy_str(it, MESSAGE_KEY_SLEEP_SCORE, s->sleep_score, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_SLEEP_DURATION, s->sleep_dur, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_SLEEP_DEEP, s->sleep_deep, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_SLEEP_REM, s->sleep_rem, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_SLEEP_CYCLES, s->sleep_cycles, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_RECOVERY, s->recovery, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_HRV, s->hrv, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_RHR, s->rhr, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_SPO2, s->spo2, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_TEMP, s->temp, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_STEPS, s->steps, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_ACTIVE_MIN, s->active, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_MOVE_IDX, s->move, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_VO2_MAX, s->vo2, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_HOME_AQI, s->aqi, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_HOME_CO2, s->co2, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_HOME_PM25, s->pm25, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_HOME_TEMP, s->home_temp, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_HOME_HUMIDITY, s->humidity, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_HOME_NOISE, s->noise, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_BODY_WEIGHT, s->weight, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_BODY_FAT, s->fat, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_BODY_MUSCLE, s->muscle, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_BODY_WATER, s->water, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_BODY_MEASURED, s->measured, VAL_LEN);
  prv_copy_str(it, MESSAGE_KEY_UPDATED, s->updated, VAL_LEN);
  s->steps_num = prv_get_int(it, MESSAGE_KEY_STEPS_NUM, s->steps_num);
  s->steps_pct = prv_get_int(it, MESSAGE_KEY_STEPS_PCT, s->steps_pct);
  s->typical_pct = prv_get_int(it, MESSAGE_KEY_TYPICAL_PCT, s->typical_pct);
  s->sleep_min = prv_get_int(it, MESSAGE_KEY_SLEEP_MIN, s->sleep_min);
  s->rhr_num = prv_get_int(it, MESSAGE_KEY_RHR_NUM, s->rhr_num);
  s->hrv_num = prv_get_int(it, MESSAGE_KEY_HRV_NUM, s->hrv_num);
  s->hrv_trend = prv_get_int(it, MESSAGE_KEY_HRV_TREND, s->hrv_trend);
  s->home_enabled = prv_get_int(it, MESSAGE_KEY_HOME_ENABLED, s->home_enabled) != 0;
  s->body_present = prv_get_int(it, MESSAGE_KEY_BODY_PRESENT, s->body_present) != 0;
  s->stale = prv_get_int(it, MESSAGE_KEY_STALE, s->stale) != 0;

  bool first = !s_have_data;
  s_have_data = true;
  prv_rebuild_cards();
  prv_state_save();

  for (int i = 0; i < s_ncards; i++) {
    layer_set_hidden(s_card_layers[i], i != s_card);
    layer_set_update_proc(s_card_layers[i], CARD_UPDATE_PROCS[s_cards[i]]);
  }
  window_set_background_color(s_window, prv_card_bg(s_cards[s_card]));
  layer_mark_dirty(window_get_root_layer(s_window));
  if (first || s_detail_window == NULL) {
    prv_start_reveal();
  }
  prv_pulse_ensure();
}

static void prv_request_refresh(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_uint8(out, MESSAGE_KEY_REQUEST_REFRESH, 1);
  app_message_outbox_send();
}

// ---------------------------------------------------------------------------
// Buttons: UP goes deeper, DOWN backs out (to the watchface from card 1),
// SELECT opens details, long SELECT re-fetches — same scheme as the system app.

static void prv_up_click(ClickRecognizerRef rec, void *context) {
  if (!s_have_data) return;
  if (s_card + 1 < s_ncards) {
    prv_slide_to_card(s_card + 1, true);
  }
}

static void prv_down_click(ClickRecognizerRef rec, void *context) {
  if (!s_have_data) return;
  if (s_card > 0) {
    prv_slide_to_card(s_card - 1, false);
  } else {
    window_stack_pop_all(true);  // back to the watchface, like the system app
  }
}

static void prv_select_click(ClickRecognizerRef rec, void *context) {
  prv_show_detail();
}

static void prv_select_long_click(ClickRecognizerRef rec, void *context) {
  vibes_short_pulse();
  prv_request_refresh();
}

static void prv_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, prv_up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 0, prv_select_long_click, NULL);
}

// ---------------------------------------------------------------------------
// Main window

static void prv_loading_update(Layer *layer, GContext *ctx) {
  if (s_have_data) return;
  GRect b = layer_get_bounds(layer);
  const int inset = PBL_IF_ROUND_ELSE(26, 10);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, s_status, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                     GRect(inset, b.size.h / 2 - 42, b.size.w - 2 * inset, 84),
                     GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  for (int i = 0; i < CARD_TYPE_COUNT; i++) {
    s_card_layers[i] = layer_create(bounds);
    layer_set_hidden(s_card_layers[i], true);
    layer_add_child(root, s_card_layers[i]);
  }
  s_chrome_layer = layer_create(bounds);
  layer_set_update_proc(s_chrome_layer, prv_chrome_update);
  layer_add_child(root, s_chrome_layer);

  if (s_have_data) {
    for (int i = 0; i < s_ncards; i++) {
      layer_set_update_proc(s_card_layers[i], CARD_UPDATE_PROCS[s_cards[i]]);
    }
    layer_set_hidden(s_card_layers[s_card], false);
    window_set_background_color(window, prv_card_bg(s_cards[s_card]));
    prv_start_reveal();
    prv_pulse_ensure();
  } else {
    layer_set_update_proc(s_chrome_layer, prv_chrome_update);
    // loading text rides on the chrome layer's window: draw via a dedicated proc
    layer_set_update_proc(s_card_layers[0], prv_loading_update);
    layer_set_hidden(s_card_layers[0], false);
    window_set_background_color(window, GColorBlack);
  }
}

static void prv_window_unload(Window *window) {
  for (int i = 0; i < CARD_TYPE_COUNT; i++) {
    layer_destroy(s_card_layers[i]);
    s_card_layers[i] = NULL;
  }
  layer_destroy(s_chrome_layer);
}

static void prv_init(void) {
  s_heart_tri = gpath_create(&(GPathInfo){.num_points = 3, .points = s_heart_tri_points});
  s_trend_tri = gpath_create(&(GPathInfo){.num_points = 3, .points = s_trend_tri_points});

  if (prv_state_load()) {
    s_have_data = true;
  }
  prv_rebuild_cards();

  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(prv_inbox_received);
  app_message_open(1024, 64);
}

static void prv_deinit(void) {
  animation_unschedule_all();
  gpath_destroy(s_heart_tri);
  gpath_destroy(s_trend_tri);
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
