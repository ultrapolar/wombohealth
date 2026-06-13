// Phone-side companion for Proton Cal.
//
// 1. Fetches the Worker's GET /calendar (Proton "share via link" ICS, parsed
//    and expanded server-side) and streams events to the watch one message
//    at a time (AppMessage dicts are small).
// 2. Pushes the same events as real system timeline pins via the Rebble/Core
//    timeline API, so Proton events appear in the watch's timeline view the
//    way Google Calendar events do with the stock setup.

var Clay = require('pebble-clay');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var DEFAULT_TIMELINE_API = 'https://timeline-api.rebble.io';
var AGENDA_DAYS = 4;
var MAX_SEND = 24;

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

function workerBase() {
  var url = str(settings().workerUrl).trim().replace(/\/+$/, '');
  if (url && url.indexOf('http') !== 0) url = 'https://' + url;
  return url;
}

function sendError(msg) {
  Pebble.sendAppMessage({ ERROR: msg }, null, function () {});
}

// --- stream events to the watch, one dict per event ---

function sendQueue(msgs, done) {
  if (!msgs.length) {
    if (done) done();
    return;
  }
  var msg = msgs.shift();
  Pebble.sendAppMessage(msg, function () {
    sendQueue(msgs, done);
  }, function () {
    // one retry, then give up quietly (the watch shows what it got)
    Pebble.sendAppMessage(msg, function () {
      sendQueue(msgs, done);
    }, function () {
      console.log('appmessage send failed twice, aborting stream');
    });
  });
}

function sendAgenda(events, statusSuffix) {
  var n = Math.min(events.length, MAX_SEND);
  var msgs = [{ EV_COUNT: n }];
  for (var i = 0; i < n; i++) {
    var ev = events[i];
    msgs.push({
      EV_INDEX: i,
      EV_TITLE: str(ev.title).slice(0, 35),
      EV_LOC: str(ev.location).slice(0, 27),
      EV_START: ev.start,
      EV_DUR: Math.max(0, Math.min(65535, Math.round((ev.end - ev.start) / 60))),
      EV_ALLDAY: ev.all_day ? 1 : 0,
    });
  }
  msgs.push({ STATUS: n + ' events' + (statusSuffix ? ' · ' + statusSuffix : '') });
  sendQueue(msgs);
}

// --- timeline pins ---

function hashId(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function pinFor(ev) {
  var pin = {
    id: 'pcal-' + hashId(ev.id),
    time: new Date(ev.start * 1000).toISOString(),
    layout: {
      type: 'calendarPin',
      title: str(ev.title),
      tinyIcon: 'system://images/TIMELINE_CALENDAR',
    },
  };
  if (!ev.all_day) pin.duration = Math.round((ev.end - ev.start) / 60);
  if (ev.location) pin.layout.locationName = str(ev.location);
  return pin;
}

function timelineRequest(api, token, method, pin, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open(method, api + '/v1/user/pins/' + pin.id, true);
  xhr.setRequestHeader('X-User-Token', token);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.timeout = 15000;
  xhr.onload = function () { cb(xhr.status >= 200 && xhr.status < 300); };
  xhr.onerror = function () { cb(false); };
  xhr.ontimeout = function () { cb(false); };
  xhr.send(method === 'PUT' ? JSON.stringify(pin) : null);
}

function loadPinned() {
  try {
    return JSON.parse(localStorage.getItem('pinned-pins')) || {};
  } catch (e) {
    return {};
  }
}

function pushPins(events, doneStatus) {
  var s = settings();
  if (s.pushPins === false || s.pushPins === 'false') {
    doneStatus('pins off');
    return;
  }
  var api = str(s.timelineApi).trim().replace(/\/+$/, '') || DEFAULT_TIMELINE_API;

  Pebble.getTimelineToken(function (token) {
    var pinned = loadPinned();
    var fresh = {};
    var queue = [];

    events.forEach(function (ev) {
      var pin = pinFor(ev);
      var sig = hashId(pin.time + '|' + pin.layout.title + '|' + (pin.layout.locationName || ''));
      fresh[pin.id] = sig;
      if (pinned[pin.id] !== sig) queue.push({ method: 'PUT', pin: pin });
    });
    // delete pins for events that vanished from the feed
    Object.keys(pinned).forEach(function (id) {
      if (!fresh[id]) queue.push({ method: 'DELETE', pin: { id: id } });
    });

    var ok = 0;
    var fail = 0;
    (function next() {
      if (!queue.length) {
        localStorage.setItem('pinned-pins', JSON.stringify(fresh));
        doneStatus(fail ? ok + ' pins, ' + fail + ' failed' : 'pins synced');
        return;
      }
      var job = queue.shift();
      timelineRequest(api, token, job.method, job.pin, function (success) {
        if (success) ok++; else fail++;
        next();
      });
    })();
  }, function (err) {
    console.log('timeline token unavailable: ' + err);
    // Sideloaded apps can't always get a token (store-published apps can).
    doneStatus('pins unavailable');
  });
}

// --- sync ---

function sync() {
  var base = workerBase();
  if (!base) {
    sendError('Set the Worker URL in the phone settings');
    return;
  }
  var xhr = new XMLHttpRequest();
  xhr.open('GET', base + '/calendar?days=' + AGENDA_DAYS, true);
  xhr.setRequestHeader('X-Export-Key', str(settings().exportKey).trim());
  xhr.timeout = 20000;
  xhr.onload = function () {
    if (xhr.status === 401) { sendError('Bad export key in settings'); return; }
    if (xhr.status === 400) { sendError('Worker: PROTON_ICS_URL not set'); return; }
    if (xhr.status !== 200) { sendError('Worker error HTTP ' + xhr.status); return; }
    var events;
    try {
      events = JSON.parse(xhr.responseText).events || [];
    } catch (e) {
      sendError('Bad JSON from worker');
      return;
    }
    // Agenda first — the watch shouldn't wait on up to two dozen pin PUTs.
    sendAgenda(events, 'pins syncing...');
    pushPins(events, function (pinStatus) {
      Pebble.sendAppMessage(
        { STATUS: Math.min(events.length, MAX_SEND) + ' events · ' + pinStatus },
        null, function () {});
    });
  };
  xhr.onerror = function () { sendError('Network error reaching worker'); };
  xhr.ontimeout = function () { sendError('Worker timed out'); };
  xhr.send();
}

Pebble.addEventListener('ready', function () {
  sync();
});

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload && e.payload.REQUEST_REFRESH) sync();
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (e && e.response) {
    clay.getSettings(e.response);
    sync();
  }
});
