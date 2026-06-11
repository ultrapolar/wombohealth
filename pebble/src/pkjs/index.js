// Phone-side companion: fetches the Worker's flat display payload (the same
// JSON TRMNL polls) and forwards pre-formatted strings to the watch.
// Settings (Worker URL + export key) come from the Clay config page.

var Clay = require('pebble-clay');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

function settings() {
  try {
    return JSON.parse(localStorage.getItem('clay-settings')) || {};
  } catch (e) {
    return {};
  }
}

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

// '--' placeholders from the worker stay as-is; the watch also renders '' as '--'.
function groupDigits(n) {
  var v = Number(n);
  if (isNaN(v)) return str(n);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// The worker's hrv_icon is ▲/▼/− — not all watch fonts have those glyphs.
function trendSuffix(icon) {
  if (icon === '▲') return ' +';
  if (icon === '▼') return ' -';
  return '';
}

function sendError(msg) {
  Pebble.sendAppMessage({ ERROR: msg }, null, function () {
    console.log('failed to send error to watch');
  });
}

function fetchData() {
  var s = settings();
  var url = str(s.workerUrl).trim().replace(/\/+$/, '');
  if (!url) {
    sendError('Set the Worker URL in the app settings on your phone.');
    return;
  }
  if (url.indexOf('http') !== 0) url = 'https://' + url;
  var full = url + '/?key=' + encodeURIComponent(str(s.exportKey).trim());

  var xhr = new XMLHttpRequest();
  xhr.open('GET', full, true);
  xhr.timeout = 15000;
  xhr.onload = function () {
    if (xhr.status === 401) {
      sendError('Unauthorized: check the export key in settings.');
      return;
    }
    if (xhr.status !== 200) {
      sendError('Worker error: HTTP ' + xhr.status);
      return;
    }
    var p;
    try {
      p = JSON.parse(xhr.responseText);
    } catch (e) {
      sendError('Bad JSON from worker.');
      return;
    }
    var body = p.body || {};
    var dict = {
      SLEEP_SCORE: str(p.sleep_score),
      SLEEP_DURATION: str(p.sleep_duration),
      SLEEP_DEEP: str(p.deep_duration),
      SLEEP_REM: str(p.rem_duration),
      SLEEP_CYCLES: str(p.sleep_cycles),
      RECOVERY: str(p.recovery_score),
      HRV: str(p.hrv) + trendSuffix(p.hrv_icon),
      RHR: str(p.rhr),
      SPO2: str(p.spo2),
      TEMP: str(p.avg_temp),
      STEPS: groupDigits(p.steps),
      ACTIVE_MIN: str(p.active_min),
      MOVE_IDX: str(p.movement_idx),
      VO2_MAX: str(p.vo2_max),
      HOME_ENABLED: p.home_enabled ? 1 : 0,
      HOME_AQI: str(p.home_aqi),
      HOME_CO2: str(p.home_co2),
      HOME_PM25: str(p.home_pm25),
      HOME_TEMP: str(p.home_temp),
      HOME_HUMIDITY: str(p.home_humidity),
      HOME_NOISE: str(p.home_noise),
      BODY_PRESENT: p.body ? 1 : 0,
      BODY_WEIGHT: str(body.weight),
      BODY_FAT: str(body.body_fat),
      BODY_MUSCLE: str(body.muscle),
      BODY_WATER: str(body.water),
      BODY_MEASURED: str(body.measured),
      UPDATED: str(p.meta && p.meta.last_updated),
      STALE: p.meta && p.meta.stale ? 1 : 0,
    };
    Pebble.sendAppMessage(dict, null, function () {
      console.log('failed to send payload to watch');
    });
  };
  xhr.onerror = function () {
    sendError('Network error reaching worker.');
  };
  xhr.ontimeout = function () {
    sendError('Worker request timed out.');
  };
  xhr.send();
}

Pebble.addEventListener('ready', function () {
  fetchData();
});

// The watch's SELECT button asks for a re-fetch.
Pebble.addEventListener('appmessage', function (e) {
  if (e.payload && e.payload.REQUEST_REFRESH) {
    fetchData();
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (e && e.response) {
    clay.getSettings(e.response);
    fetchData();
  }
});
