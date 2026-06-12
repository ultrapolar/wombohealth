// Rambles — dictate a note on the watch mic, file it into Obsidian.
//
// Flow: launch -> system dictation UI -> preview (auto-detected category from
// a leading keyword like "to do" / "important"; UP/DOWN overrides) -> SELECT
// sends to the phone JS, which POSTs to the Worker's /ingest/ramble. The
// exporter later appends it to the vault's Rambles folder under the matching
// section. The keyword is stripped server-side; the preview shows raw speech.

#include <pebble.h>
#include <strings.h>

#define TEXT_LEN 512

typedef enum {
  CatRamble,
  CatTodo,
  CatImportant,
  CatIdea,
  CatQuestion,
  CAT_COUNT,
} Category;

static const char *CAT_NAMES[CAT_COUNT] = {
  [CatRamble] = "RAMBLE",
  [CatTodo] = "TO DO",
  [CatImportant] = "IMPORTANT",
  [CatIdea] = "IDEA",
  [CatQuestion] = "QUESTION",
};

// Wire names must match src/rambles.js CATEGORIES.
static const char *CAT_WIRE[CAT_COUNT] = {
  [CatRamble] = "ramble",
  [CatTodo] = "todo",
  [CatImportant] = "important",
  [CatIdea] = "idea",
  [CatQuestion] = "question",
};

static GColor prv_cat_color(Category c) {
  switch (c) {
    case CatTodo:      return PBL_IF_COLOR_ELSE(GColorIslamicGreen, GColorBlack);
    case CatImportant: return PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
    case CatIdea:      return PBL_IF_COLOR_ELSE(GColorChromeYellow, GColorBlack);
    case CatQuestion:  return PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorBlack);
    default:           return PBL_IF_COLOR_ELSE(GColorDukeBlue, GColorBlack);
  }
}

typedef enum {
  StateIdle,     // mic icon, SELECT to talk
  StatePreview,  // transcript + category, SELECT to send
  StateSending,
  StateSaved,    // checkmark pop
  StateError,
} State;

static State s_state = StateIdle;
static char s_text[TEXT_LEN];
static Category s_category;
static char s_error[64];

static Window *s_window;
static Layer *s_layer;
static DictationSession *s_dictation;
static AppTimer *s_anim_timer;
static int s_anim_phase;       // idle mic breathing / sending dots / saved pop

// ---------------------------------------------------------------------------
// Category auto-detect (display only — the Worker re-parses authoritatively)

static bool prv_starts_with(const char *text, const char *kw) {
  size_t n = strlen(kw);
  if (strncasecmp(text, kw, n) != 0) return false;
  char next = text[n];
  return next == '\0' || next == ' ' || next == ',' || next == ':' || next == '.';
}

static Category prv_detect_category(const char *text) {
  while (*text == ' ') text++;
  if (prv_starts_with(text, "to do") || prv_starts_with(text, "todo") ||
      prv_starts_with(text, "to-do") || prv_starts_with(text, "task")) return CatTodo;
  if (prv_starts_with(text, "important") || prv_starts_with(text, "remember")) return CatImportant;
  if (prv_starts_with(text, "idea")) return CatIdea;
  if (prv_starts_with(text, "question")) return CatQuestion;
  return CatRamble;
}

// ---------------------------------------------------------------------------
// Animation ticker (one slow timer drives all the little touches)

static void prv_anim_tick(void *ctx) {
  s_anim_timer = NULL;
  // Preview and error screens are static — let the timer die there instead of
  // redrawing at 11fps forever; transitions back re-arm via prv_anim_restart.
  if (s_state == StatePreview || s_state == StateError) return;
  s_anim_phase++;
  if (s_state == StateSaved && s_anim_phase > 14) {
    s_state = StateIdle;
    s_anim_phase = 0;
  }
  layer_mark_dirty(s_layer);
  s_anim_timer = app_timer_register(90, prv_anim_tick, NULL);
}

static void prv_anim_restart(void) {
  s_anim_phase = 0;
  if (!s_anim_timer) s_anim_timer = app_timer_register(90, prv_anim_tick, NULL);
}

// ---------------------------------------------------------------------------
// Drawing

static void prv_draw_mic(GContext *ctx, GPoint c, GColor color) {
  graphics_context_set_fill_color(ctx, color);
  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_stroke_width(ctx, 3);
  graphics_fill_rect(ctx, GRect(c.x - 7, c.y - 18, 14, 24), 7, GCornersAll);
  // cradle arc + stem + base
  graphics_draw_arc(ctx, GRect(c.x - 12, c.y - 10, 24, 24), GOvalScaleModeFitCircle,
                    DEG_TO_TRIGANGLE(90), DEG_TO_TRIGANGLE(270));
  graphics_draw_line(ctx, GPoint(c.x, c.y + 14), GPoint(c.x, c.y + 20));
  graphics_draw_line(ctx, GPoint(c.x - 7, c.y + 20), GPoint(c.x + 7, c.y + 20));
}

static void prv_draw_idle(GContext *ctx, GRect b) {
  GPoint c = GPoint(b.size.w / 2, b.size.h / 2 - 18);
  // breathing ring
  int r = 30 + ((s_anim_phase % 16 < 8) ? (s_anim_phase % 8) : (8 - s_anim_phase % 8));
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorPictonBlue, GColorWhite));
  graphics_context_set_stroke_width(ctx, 2);
  graphics_draw_circle(ctx, c, r);
  prv_draw_mic(ctx, c, GColorWhite);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, "Press SELECT\nand just talk",
                     fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(0, b.size.h - 62, b.size.w, 50),
                     GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
}

static void prv_draw_preview(GContext *ctx, GRect b) {
  const int inset = PBL_IF_ROUND_ELSE(24, 6);
  const int bar_h = 28;
  graphics_context_set_fill_color(ctx, prv_cat_color(s_category));
  graphics_fill_rect(ctx, GRect(0, 0, b.size.w, bar_h), 0, GCornerNone);
  graphics_context_set_text_color(ctx, gcolor_legible_over(prv_cat_color(s_category)));
  char title[24];
  snprintf(title, sizeof(title), "< %s >", CAT_NAMES[s_category]);
  graphics_draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(0, -1, b.size.w, bar_h), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);

  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, s_text, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(inset, bar_h + 2, b.size.w - 2 * inset, b.size.h - bar_h - 24),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  graphics_draw_text(ctx, "SELECT sends it",
                     fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(0, b.size.h - 20, b.size.w, 18),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void prv_draw_sending(GContext *ctx, GRect b) {
  char dots[8];
  int n = (s_anim_phase % 4);
  snprintf(dots, sizeof(dots), "%.*s", n, "...");
  char msg[24];
  snprintf(msg, sizeof(msg), "Sending%s", dots);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, msg, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                     GRect(0, b.size.h / 2 - 16, b.size.w, 32),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void prv_draw_saved(GContext *ctx, GRect b) {
  GPoint c = GPoint(b.size.w / 2, b.size.h / 2 - 14);
  // circle pops with a little overshoot, then the check draws in
  static const int8_t POP[10] = {4, 12, 22, 30, 34, 31, 29, 30, 30, 30};
  int p = s_anim_phase < 10 ? s_anim_phase : 9;
  GColor col = prv_cat_color(s_category);
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(col, GColorWhite));
  graphics_fill_circle(ctx, c, POP[p]);
  if (s_anim_phase >= 4) {
    graphics_context_set_stroke_color(ctx, gcolor_legible_over(PBL_IF_COLOR_ELSE(col, GColorWhite)));
    graphics_context_set_stroke_width(ctx, 4);
    graphics_draw_line(ctx, GPoint(c.x - 11, c.y + 1), GPoint(c.x - 3, c.y + 9));
    if (s_anim_phase >= 6) {
      graphics_draw_line(ctx, GPoint(c.x - 3, c.y + 9), GPoint(c.x + 12, c.y - 8));
    }
  }
  char msg[28];
  snprintf(msg, sizeof(msg), "Filed: %s", CAT_NAMES[s_category]);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, msg, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(0, b.size.h - 52, b.size.w, 24),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void prv_draw_error(GContext *ctx, GRect b) {
  const int inset = PBL_IF_ROUND_ELSE(24, 10);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, s_error, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(inset, b.size.h / 2 - 40, b.size.w - 2 * inset, 70),
                     GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, "SELECT retries",
                     fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(0, b.size.h - 22, b.size.w, 18),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void prv_layer_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  switch (s_state) {
    case StateIdle:    prv_draw_idle(ctx, b); break;
    case StatePreview: prv_draw_preview(ctx, b); break;
    case StateSending: prv_draw_sending(ctx, b); break;
    case StateSaved:   prv_draw_saved(ctx, b); break;
    case StateError:   prv_draw_error(ctx, b); break;
  }
}

// ---------------------------------------------------------------------------
// Send to phone

static void prv_send(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    snprintf(s_error, sizeof(s_error), "Phone link busy");
    s_state = StateError;
    layer_mark_dirty(s_layer);
    return;
  }
  dict_write_cstring(out, MESSAGE_KEY_TEXT, s_text);
  dict_write_cstring(out, MESSAGE_KEY_CATEGORY, CAT_WIRE[s_category]);
  dict_write_uint32(out, MESSAGE_KEY_TS, (uint32_t)time(NULL));
  app_message_outbox_send();
  s_state = StateSending;
  prv_anim_restart();
  layer_mark_dirty(s_layer);
}

static void prv_outbox_failed(DictionaryIterator *it, AppMessageResult reason, void *ctx) {
  snprintf(s_error, sizeof(s_error), "Can't reach the phone");
  s_state = StateError;
  layer_mark_dirty(s_layer);
}

static void prv_inbox_received(DictionaryIterator *it, void *ctx) {
  Tuple *res = dict_find(it, MESSAGE_KEY_RESULT);
  if (!res) return;
  if (res->value->int32 == 1) {
    s_state = StateSaved;
    prv_anim_restart();
    vibes_double_pulse();
  } else {
    Tuple *err = dict_find(it, MESSAGE_KEY_ERROR);
    if (err && err->type == TUPLE_CSTRING && err->length > 1) {
      snprintf(s_error, sizeof(s_error), "%s", err->value->cstring);
    } else {
      snprintf(s_error, sizeof(s_error), "Worker rejected it");
    }
    s_state = StateError;
  }
  layer_mark_dirty(s_layer);
}

// ---------------------------------------------------------------------------
// Dictation

static void prv_dictation_cb(DictationSession *session, DictationSessionStatus status,
                             char *transcript, void *ctx) {
  if (status == DictationSessionStatusSuccess && transcript && transcript[0]) {
    snprintf(s_text, sizeof(s_text), "%s", transcript);
    s_category = prv_detect_category(s_text);
    s_state = StatePreview;
  } else if (s_state != StatePreview) {
    s_state = StateIdle;  // cancelled / no speech: back to the mic
    prv_anim_restart();
  }
  layer_mark_dirty(s_layer);
}

static void prv_start_dictation(void) {
  if (!s_dictation) {
    s_dictation = dictation_session_create(TEXT_LEN, prv_dictation_cb, NULL);
    if (!s_dictation) {  // no mic on this watch
      snprintf(s_error, sizeof(s_error), "No microphone on this watch");
      s_state = StateError;
      layer_mark_dirty(s_layer);
      return;
    }
    dictation_session_enable_confirmation(s_dictation, false);  // we do our own preview
    dictation_session_enable_error_dialogs(s_dictation, true);
  }
  dictation_session_start(s_dictation);
}

// ---------------------------------------------------------------------------
// Buttons

static void prv_select_click(ClickRecognizerRef rec, void *ctx) {
  switch (s_state) {
    case StateIdle:
    case StateSaved:
      prv_start_dictation();
      break;
    case StatePreview:
      prv_send();
      break;
    case StateError:
      // retry: still have text? re-send. Otherwise dictate again.
      if (s_text[0]) {
        s_state = StatePreview;
        layer_mark_dirty(s_layer);
      } else {
        prv_start_dictation();
      }
      break;
    default:
      break;
  }
}

static void prv_up_down_click(ClickRecognizerRef rec, void *ctx) {
  if (s_state != StatePreview) return;
  const int dir = (click_recognizer_get_button_id(rec) == BUTTON_ID_UP) ? -1 : 1;
  s_category = (Category)((s_category + CAT_COUNT + dir) % CAT_COUNT);
  layer_mark_dirty(s_layer);
}

static void prv_back_click(ClickRecognizerRef rec, void *ctx) {
  if (s_state == StatePreview || s_state == StateError) {
    s_text[0] = '\0';
    s_state = StateIdle;  // discard, don't exit
    prv_anim_restart();
    layer_mark_dirty(s_layer);
  } else {
    window_stack_pop_all(true);
  }
}

static void prv_click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
  window_single_click_subscribe(BUTTON_ID_UP, prv_up_down_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_up_down_click);
  window_single_click_subscribe(BUTTON_ID_BACK, prv_back_click);
}

// ---------------------------------------------------------------------------

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_layer, prv_layer_update);
  layer_add_child(root, s_layer);
  prv_anim_restart();
}

static void prv_window_unload(Window *window) {
  layer_destroy(s_layer);
}

static void prv_init(void) {
  s_window = window_create();
  window_set_background_color(s_window, PBL_IF_COLOR_ELSE(GColorOxfordBlue, GColorBlack));
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_outbox_failed(prv_outbox_failed);
  app_message_open(256, 1024);

  prv_start_dictation();  // launch straight into "just talk"
}

static void prv_deinit(void) {
  if (s_dictation) dictation_session_destroy(s_dictation);
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
