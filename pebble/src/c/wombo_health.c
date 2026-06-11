// Wombo Health — Pebble watchapp for the trmnl-health Cloudflare Worker.
//
// The phone-side JS (src/pkjs/index.js) fetches the Worker's flat display
// payload (GET /?key=…, the same one TRMNL polls) and forwards pre-formatted
// strings over AppMessage. The watch just stores them and draws cards:
//   Sleep · Recovery · Activity · Air (if Ultrahuman Home) · Body (if Wyze)
// UP/DOWN switch cards, SELECT asks the phone to re-fetch.

#include <pebble.h>

#define VAL_LEN 20

// Value buffers, filled from AppMessage. Empty string renders as "--".
static char s_sleep_score[VAL_LEN], s_sleep_dur[VAL_LEN], s_sleep_deep[VAL_LEN],
    s_sleep_rem[VAL_LEN], s_sleep_cycles[VAL_LEN];
static char s_recovery[VAL_LEN], s_hrv[VAL_LEN], s_rhr[VAL_LEN], s_spo2[VAL_LEN],
    s_temp[VAL_LEN];
static char s_steps[VAL_LEN], s_active[VAL_LEN], s_move[VAL_LEN], s_vo2[VAL_LEN];
static char s_aqi[VAL_LEN], s_co2[VAL_LEN], s_pm25[VAL_LEN], s_home_temp[VAL_LEN],
    s_humidity[VAL_LEN], s_noise[VAL_LEN];
static char s_weight[VAL_LEN], s_fat[VAL_LEN], s_muscle[VAL_LEN], s_water[VAL_LEN],
    s_measured[VAL_LEN];
static char s_updated[VAL_LEN];
static bool s_home_enabled, s_body_present, s_stale;

static bool s_have_data;
static char s_status[80] = "Loading...";

typedef struct {
  const char *label;
  const char *value;
} Row;

typedef struct {
  const char *title;
  Row rows[6];
  int nrows;
} Card;

#define MAX_CARDS 5
static Card s_cards[MAX_CARDS];
static int s_ncards;
static int s_card;

static Window *s_window;
static Layer *s_layer;

static void rebuild_cards(void) {
  s_ncards = 0;

  s_cards[s_ncards++] = (Card){
    .title = "Sleep", .nrows = 5, .rows = {
      {"Score", s_sleep_score}, {"Duration", s_sleep_dur}, {"Deep", s_sleep_deep},
      {"REM", s_sleep_rem}, {"Cycles", s_sleep_cycles},
    }};

  s_cards[s_ncards++] = (Card){
    .title = "Recovery", .nrows = 5, .rows = {
      {"Score", s_recovery}, {"HRV", s_hrv}, {"RHR", s_rhr},
      {"SpO2", s_spo2}, {"Skin temp", s_temp},
    }};

  s_cards[s_ncards++] = (Card){
    .title = "Activity", .nrows = 4, .rows = {
      {"Steps", s_steps}, {"Active", s_active}, {"Movement", s_move},
      {"VO2 max", s_vo2},
    }};

  if (s_home_enabled) {
    s_cards[s_ncards++] = (Card){
      .title = "Air", .nrows = 6, .rows = {
        {"AQI", s_aqi}, {"CO2", s_co2}, {"PM2.5", s_pm25},
        {"Temp", s_home_temp}, {"Humidity", s_humidity}, {"Noise", s_noise},
      }};
  }

  if (s_body_present) {
    s_cards[s_ncards++] = (Card){
      .title = "Body", .nrows = 5, .rows = {
        {"Weight", s_weight}, {"Body fat", s_fat}, {"Muscle", s_muscle},
        {"Water", s_water}, {"Measured", s_measured},
      }};
  }

  if (s_card >= s_ncards) {
    s_card = 0;
  }
}

static void draw_layer(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const int inset = PBL_IF_ROUND_ELSE(26, 6);

  if (!s_have_data) {
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, s_status, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                       GRect(inset, b.size.h / 2 - 42, b.size.w - 2 * inset, 84),
                       GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }

  const Card *card = &s_cards[s_card];

  const int bar_h = 26;
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorDukeBlue, GColorBlack));
  graphics_fill_rect(ctx, GRect(0, 0, b.size.w, bar_h), 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);
  char title[32];
  snprintf(title, sizeof(title), "%s  %d/%d", card->title, s_card + 1, s_ncards);
  graphics_draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(0, -2, b.size.w, bar_h), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);

  const int footer_h = 18;
  const int label_w = 64;
  int area_h = b.size.h - bar_h - footer_h;
  int row_h = area_h / card->nrows;
  graphics_context_set_text_color(ctx, GColorBlack);
  for (int i = 0; i < card->nrows; i++) {
    int y = bar_h + i * row_h + (row_h - 22) / 2;
    graphics_draw_text(ctx, card->rows[i].label, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(inset, y + 3, label_w, row_h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    const char *v = card->rows[i].value[0] ? card->rows[i].value : "--";
    graphics_draw_text(ctx, v, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       GRect(inset + label_w, y, b.size.w - 2 * inset - label_w, row_h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  }

  char footer[40];
  if (s_stale) {
    snprintf(footer, sizeof(footer), "upd %s (stale)", s_updated);
  } else {
    snprintf(footer, sizeof(footer), "upd %s", s_updated);
  }
  graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  graphics_draw_text(ctx, footer, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(0, b.size.h - footer_h - 2, b.size.w, footer_h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void copy_str(DictionaryIterator *it, uint32_t key, char *buf, size_t len) {
  Tuple *t = dict_find(it, key);
  if (t && t->type == TUPLE_CSTRING) {
    strncpy(buf, t->value->cstring, len - 1);
    buf[len - 1] = '\0';
  }
}

static bool flag(DictionaryIterator *it, uint32_t key, bool fallback) {
  Tuple *t = dict_find(it, key);
  return t ? (t->value->int32 != 0) : fallback;
}

static void inbox_received(DictionaryIterator *it, void *context) {
  Tuple *err = dict_find(it, MESSAGE_KEY_ERROR);
  if (err && err->type == TUPLE_CSTRING && err->length > 1) {
    snprintf(s_status, sizeof(s_status), "%s", err->value->cstring);
    s_have_data = false;
    layer_mark_dirty(s_layer);
    return;
  }

  copy_str(it, MESSAGE_KEY_SLEEP_SCORE, s_sleep_score, VAL_LEN);
  copy_str(it, MESSAGE_KEY_SLEEP_DURATION, s_sleep_dur, VAL_LEN);
  copy_str(it, MESSAGE_KEY_SLEEP_DEEP, s_sleep_deep, VAL_LEN);
  copy_str(it, MESSAGE_KEY_SLEEP_REM, s_sleep_rem, VAL_LEN);
  copy_str(it, MESSAGE_KEY_SLEEP_CYCLES, s_sleep_cycles, VAL_LEN);
  copy_str(it, MESSAGE_KEY_RECOVERY, s_recovery, VAL_LEN);
  copy_str(it, MESSAGE_KEY_HRV, s_hrv, VAL_LEN);
  copy_str(it, MESSAGE_KEY_RHR, s_rhr, VAL_LEN);
  copy_str(it, MESSAGE_KEY_SPO2, s_spo2, VAL_LEN);
  copy_str(it, MESSAGE_KEY_TEMP, s_temp, VAL_LEN);
  copy_str(it, MESSAGE_KEY_STEPS, s_steps, VAL_LEN);
  copy_str(it, MESSAGE_KEY_ACTIVE_MIN, s_active, VAL_LEN);
  copy_str(it, MESSAGE_KEY_MOVE_IDX, s_move, VAL_LEN);
  copy_str(it, MESSAGE_KEY_VO2_MAX, s_vo2, VAL_LEN);
  copy_str(it, MESSAGE_KEY_HOME_AQI, s_aqi, VAL_LEN);
  copy_str(it, MESSAGE_KEY_HOME_CO2, s_co2, VAL_LEN);
  copy_str(it, MESSAGE_KEY_HOME_PM25, s_pm25, VAL_LEN);
  copy_str(it, MESSAGE_KEY_HOME_TEMP, s_home_temp, VAL_LEN);
  copy_str(it, MESSAGE_KEY_HOME_HUMIDITY, s_humidity, VAL_LEN);
  copy_str(it, MESSAGE_KEY_HOME_NOISE, s_noise, VAL_LEN);
  copy_str(it, MESSAGE_KEY_BODY_WEIGHT, s_weight, VAL_LEN);
  copy_str(it, MESSAGE_KEY_BODY_FAT, s_fat, VAL_LEN);
  copy_str(it, MESSAGE_KEY_BODY_MUSCLE, s_muscle, VAL_LEN);
  copy_str(it, MESSAGE_KEY_BODY_WATER, s_water, VAL_LEN);
  copy_str(it, MESSAGE_KEY_BODY_MEASURED, s_measured, VAL_LEN);
  copy_str(it, MESSAGE_KEY_UPDATED, s_updated, VAL_LEN);
  s_home_enabled = flag(it, MESSAGE_KEY_HOME_ENABLED, s_home_enabled);
  s_body_present = flag(it, MESSAGE_KEY_BODY_PRESENT, s_body_present);
  s_stale = flag(it, MESSAGE_KEY_STALE, s_stale);

  s_have_data = true;
  rebuild_cards();
  layer_mark_dirty(s_layer);
}

static void request_refresh(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    return;
  }
  dict_write_uint8(out, MESSAGE_KEY_REQUEST_REFRESH, 1);
  app_message_outbox_send();
  if (!s_have_data) {
    snprintf(s_status, sizeof(s_status), "Refreshing...");
    layer_mark_dirty(s_layer);
  }
}

static void up_click(ClickRecognizerRef rec, void *context) {
  if (s_have_data && s_ncards > 0) {
    s_card = (s_card + s_ncards - 1) % s_ncards;
    layer_mark_dirty(s_layer);
  }
}

static void down_click(ClickRecognizerRef rec, void *context) {
  if (s_have_data && s_ncards > 0) {
    s_card = (s_card + 1) % s_ncards;
    layer_mark_dirty(s_layer);
  }
}

static void select_click(ClickRecognizerRef rec, void *context) {
  request_refresh();
}

static void click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_layer, draw_layer);
  layer_add_child(root, s_layer);
}

static void window_unload(Window *window) {
  layer_destroy(s_layer);
}

static void init(void) {
  rebuild_cards();

  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_click_config_provider(s_window, click_config);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox_received);
  app_message_open(1024, 64);
}

static void deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
