// Proton Cal — your Proton Calendar agenda on the watch.
//
// The phone JS fetches the Worker's GET /calendar (which reads the Proton
// "share via link" ICS feed) and streams events over AppMessage; it also
// pushes them as real system timeline pins, so they show up in the watch's
// timeline view just like Google Calendar pins would. This app is the
// in-app agenda: a menu grouped by day, Proton-purple chrome, with a
// detail card per event. Long-press SELECT re-syncs (and re-pushes pins).

#include <pebble.h>

#define MAX_EVENTS 24
#define MAX_DAYS 8
#define TITLE_LEN 36
#define LOC_LEN 28

typedef struct {
  char title[TITLE_LEN];
  char loc[LOC_LEN];
  time_t start;
  uint16_t dur_min;
  bool all_day;
} Event;

typedef struct {
  char label[20];
  int first;
  int count;
} DaySection;

static Event s_events[MAX_EVENTS];
static int s_expected = -1;   // EV_COUNT announced by the phone
static int s_received;
static bool s_loaded;
static char s_status[40] = "Syncing...";
static char s_error[64];

static DaySection s_days[MAX_DAYS];
static int s_nday;

static Window *s_window;
static MenuLayer *s_menu;
static Layer *s_spinner_layer;
static AppTimer *s_spin_timer;
static int s_spin_phase;

static Window *s_detail_window;
static Layer *s_detail_layer;
static int s_detail_idx = -1;

#define PROTON_PURPLE PBL_IF_COLOR_ELSE(GColorVividViolet, GColorBlack)

// ---------------------------------------------------------------------------
// Grouping

static void prv_day_key(time_t t, char *buf, size_t len) {
  struct tm *tm = localtime(&t);
  strftime(buf, len, "%Y-%m-%d", tm);
}

static void prv_rebuild_days(void) {
  s_nday = 0;
  char today[12], tomorrow[12];
  time_t now = time(NULL);
  prv_day_key(now, today, sizeof(today));
  time_t tmrw = now + 86400;
  prv_day_key(tmrw, tomorrow, sizeof(tomorrow));

  char prev[12] = "";
  for (int i = 0; i < s_received && s_nday <= MAX_DAYS; i++) {
    char key[12];
    prv_day_key(s_events[i].start, key, sizeof(key));
    if (strcmp(key, prev) != 0) {
      if (s_nday == MAX_DAYS) break;
      DaySection *sec = &s_days[s_nday++];
      sec->first = i;
      sec->count = 0;
      if (strcmp(key, today) == 0) {
        snprintf(sec->label, sizeof(sec->label), "Today");
      } else if (strcmp(key, tomorrow) == 0) {
        snprintf(sec->label, sizeof(sec->label), "Tomorrow");
      } else {
        struct tm *tm = localtime(&s_events[i].start);
        strftime(sec->label, sizeof(sec->label), "%A %e %b", tm);
      }
      strcpy(prev, key);
    }
    s_days[s_nday - 1].count++;
  }
}

static void prv_fmt_time(time_t t, char *buf, size_t len) {
  struct tm *tm = localtime(&t);
  strftime(buf, len, clock_is_24h_style() ? "%H:%M" : "%I:%M", tm);
  if (buf[0] == '0' && !clock_is_24h_style()) memmove(buf, buf + 1, strlen(buf));
}

// ---------------------------------------------------------------------------
// Menu callbacks

static uint16_t prv_num_sections(MenuLayer *ml, void *ctx) {
  return s_nday > 0 ? s_nday : 1;
}

static uint16_t prv_num_rows(MenuLayer *ml, uint16_t section, void *ctx) {
  if (s_nday == 0) return 1;  // "no events" row
  return s_days[section].count;
}

static int16_t prv_header_height(MenuLayer *ml, uint16_t section, void *ctx) {
  return 18;
}

static int16_t prv_cell_height(MenuLayer *ml, MenuIndex *idx, void *ctx) {
  return 42;
}

static void prv_draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *data) {
  GRect b = layer_get_bounds(cell);
  graphics_context_set_fill_color(ctx, PROTON_PURPLE);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);
  const char *label = s_nday > 0 ? s_days[section].label : "Agenda";
  graphics_draw_text(ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                     GRect(6, -3, b.size.w - 12, b.size.h),
                     GTextOverflowModeTrailingEllipsis,
                     PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft), NULL);
}

static void prv_draw_row(GContext *ctx, const Layer *cell, MenuIndex *idx, void *data) {
  GRect b = layer_get_bounds(cell);
  if (s_nday == 0) {
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, s_loaded ? "No upcoming events" : s_status,
                       fonts_get_system_font(FONT_KEY_GOTHIC_18),
                       GRect(6, 6, b.size.w - 12, 28), GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentCenter, NULL);
    return;
  }
  const Event *ev = &s_events[s_days[idx->section].first + idx->row];

  // time column
  char tbuf[10];
  if (ev->all_day) {
    snprintf(tbuf, sizeof(tbuf), "all\nday");
    graphics_draw_text(ctx, tbuf, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                       GRect(4, 4, 40, 36), GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
  } else {
    prv_fmt_time(ev->start, tbuf, sizeof(tbuf));
    graphics_draw_text(ctx, tbuf, fonts_get_system_font(FONT_KEY_LECO_20_BOLD_NUMBERS),
                       GRect(2, 8, 46, 24), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  }

  const int x = 50;
  graphics_draw_text(ctx, ev->title, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(x, -1, b.size.w - x - 4, 24), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, ev->loc[0] ? ev->loc : "", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(x, 20, b.size.w - x - 4, 18), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentLeft, NULL);
}

// ---------------------------------------------------------------------------
// Detail window

static void prv_detail_update(Layer *layer, GContext *ctx) {
  if (s_detail_idx < 0 || s_detail_idx >= s_received) return;
  const Event *ev = &s_events[s_detail_idx];
  GRect b = layer_get_bounds(layer);
  const int inset = PBL_IF_ROUND_ELSE(24, 8);

  graphics_context_set_fill_color(ctx, PROTON_PURPLE);
  graphics_fill_rect(ctx, GRect(0, 0, b.size.w, 8), 0, GCornerNone);

  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, ev->title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                     GRect(inset, 12, b.size.w - 2 * inset, 76),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  char when[48];
  if (ev->all_day) {
    struct tm *tm = localtime(&ev->start);
    strftime(when, sizeof(when), "%A %e %b · all day", tm);
  } else {
    char from[10], to[10];
    prv_fmt_time(ev->start, from, sizeof(from));
    time_t end = ev->start + (time_t)ev->dur_min * 60;
    prv_fmt_time(end, to, sizeof(to));
    char day[20];
    struct tm *tm = localtime(&ev->start);
    strftime(day, sizeof(day), "%a %e %b", tm);
    snprintf(when, sizeof(when), "%s · %s – %s", day, from, to);
  }
  graphics_context_set_text_color(ctx, PROTON_PURPLE);
  graphics_draw_text(ctx, when, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(inset, b.size.h - 66, b.size.w - 2 * inset, 24),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, ev->loc, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(inset, b.size.h - 42, b.size.w - 2 * inset, 38),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

static void prv_detail_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  s_detail_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_detail_layer, prv_detail_update);
  layer_add_child(root, s_detail_layer);
}

static void prv_detail_unload(Window *w) {
  layer_destroy(s_detail_layer);
  window_destroy(s_detail_window);
  s_detail_window = NULL;
}

static void prv_select(MenuLayer *ml, MenuIndex *idx, void *ctx) {
  if (s_nday == 0) return;
  s_detail_idx = s_days[idx->section].first + idx->row;
  s_detail_window = window_create();
  window_set_background_color(s_detail_window, GColorWhite);
  window_set_window_handlers(s_detail_window, (WindowHandlers){
    .load = prv_detail_load,
    .unload = prv_detail_unload,
  });
  window_stack_push(s_detail_window, true);
}

static void prv_request_sync(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_uint8(out, MESSAGE_KEY_REQUEST_REFRESH, 1);
  app_message_outbox_send();
}

static void prv_select_long(MenuLayer *ml, MenuIndex *idx, void *ctx) {
  vibes_short_pulse();
  s_loaded = false;
  s_expected = -1;
  s_received = 0;
  s_nday = 0;
  snprintf(s_status, sizeof(s_status), "Syncing...");
  layer_set_hidden(s_spinner_layer, false);
  menu_layer_reload_data(s_menu);
  prv_request_sync();
}

// ---------------------------------------------------------------------------
// Spinner (rotating Proton-purple arc while syncing)

static void prv_spinner_update(Layer *layer, GContext *ctx) {
  if (s_loaded) return;
  GRect b = layer_get_bounds(layer);
  GRect ring = GRect(b.size.w / 2 - 16, b.size.h / 2 - 16, 32, 32);
  int32_t a = (TRIG_MAX_ANGLE / 12) * s_spin_phase;
  graphics_context_set_fill_color(ctx, PROTON_PURPLE);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, 5, a, a + TRIG_MAX_ANGLE / 3);
  if (s_error[0]) {
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, s_error, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                       GRect(8, b.size.h / 2 + 22, b.size.w - 16, 50),
                       GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
  }
}

static void prv_spin_tick(void *ctx) {
  s_spin_timer = NULL;
  if (s_loaded) return;
  s_spin_phase = (s_spin_phase + 1) % 12;
  layer_mark_dirty(s_spinner_layer);
  s_spin_timer = app_timer_register(80, prv_spin_tick, NULL);
}

// ---------------------------------------------------------------------------
// AppMessage

static void prv_finish_load(void) {
  s_loaded = true;
  prv_rebuild_days();
  layer_set_hidden(s_spinner_layer, true);
  menu_layer_reload_data(s_menu);
}

static void prv_inbox(DictionaryIterator *it, void *ctx) {
  Tuple *t;

  if ((t = dict_find(it, MESSAGE_KEY_ERROR)) && t->type == TUPLE_CSTRING && t->length > 1) {
    snprintf(s_error, sizeof(s_error), "%s", t->value->cstring);
    layer_mark_dirty(s_spinner_layer);
    return;
  }

  if ((t = dict_find(it, MESSAGE_KEY_EV_COUNT))) {
    s_expected = t->value->int32;
    if (s_expected > MAX_EVENTS) s_expected = MAX_EVENTS;
    s_received = 0;
    s_error[0] = '\0';
    if (s_expected == 0) prv_finish_load();
    return;
  }

  if ((t = dict_find(it, MESSAGE_KEY_EV_INDEX))) {
    int i = t->value->int32;
    if (i < 0 || i >= MAX_EVENTS) return;
    Event *ev = &s_events[i];
    if ((t = dict_find(it, MESSAGE_KEY_EV_TITLE)) && t->type == TUPLE_CSTRING) {
      strncpy(ev->title, t->value->cstring, TITLE_LEN - 1);
      ev->title[TITLE_LEN - 1] = '\0';
    }
    if ((t = dict_find(it, MESSAGE_KEY_EV_LOC)) && t->type == TUPLE_CSTRING) {
      strncpy(ev->loc, t->value->cstring, LOC_LEN - 1);
      ev->loc[LOC_LEN - 1] = '\0';
    }
    if ((t = dict_find(it, MESSAGE_KEY_EV_START))) ev->start = (time_t)t->value->uint32;
    if ((t = dict_find(it, MESSAGE_KEY_EV_DUR))) ev->dur_min = t->value->uint16;
    if ((t = dict_find(it, MESSAGE_KEY_EV_ALLDAY))) ev->all_day = t->value->int32 != 0;
    if (i + 1 > s_received) s_received = i + 1;
    if (s_expected >= 0 && s_received >= s_expected) prv_finish_load();
    return;
  }

  if ((t = dict_find(it, MESSAGE_KEY_STATUS)) && t->type == TUPLE_CSTRING) {
    snprintf(s_status, sizeof(s_status), "%s", t->value->cstring);
    if (s_loaded) menu_layer_reload_data(s_menu);
  }
}

// ---------------------------------------------------------------------------

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_menu = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks){
    .get_num_sections = prv_num_sections,
    .get_num_rows = prv_num_rows,
    .get_header_height = prv_header_height,
    .get_cell_height = prv_cell_height,
    .draw_header = prv_draw_header,
    .draw_row = prv_draw_row,
    .select_click = prv_select,
    .select_long_click = prv_select_long,
  });
  menu_layer_set_highlight_colors(s_menu, PROTON_PURPLE, GColorWhite);
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));

  s_spinner_layer = layer_create(bounds);
  layer_set_update_proc(s_spinner_layer, prv_spinner_update);
  layer_add_child(root, s_spinner_layer);
  s_spin_timer = app_timer_register(80, prv_spin_tick, NULL);
}

static void prv_window_unload(Window *window) {
  menu_layer_destroy(s_menu);
  layer_destroy(s_spinner_layer);
}

static void prv_init(void) {
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(prv_inbox);
  app_message_open(512, 64);
}

static void prv_deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
