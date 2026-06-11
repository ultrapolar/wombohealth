// Phone-side companion for Rambles: receives the dictated text from the
// watch and POSTs it to the Worker's /ingest/ramble. The Worker does the
// authoritative keyword routing/stripping; we just deliver.

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

function localDate(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function reply(result, error) {
  var dict = { RESULT: result };
  if (error) dict.ERROR = error;
  Pebble.sendAppMessage(dict, null, function () {
    console.log('failed to reply to watch');
  });
}

function sendRamble(payload) {
  var s = settings();
  var url = str(s.workerUrl).trim().replace(/\/+$/, '');
  if (!url) {
    reply(0, 'Set the Worker URL in the phone settings');
    return;
  }
  if (url.indexOf('http') !== 0) url = 'https://' + url;

  var tsMs = (Number(payload.TS) || Math.round(Date.now() / 1000)) * 1000;
  var body = {
    text: str(payload.TEXT),
    category: str(payload.CATEGORY) || null,
    ts: tsMs,
    date: localDate(new Date(tsMs)),
  };

  var xhr = new XMLHttpRequest();
  xhr.open('POST', url + '/ingest/ramble', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-Export-Key', str(s.exportKey).trim());
  xhr.timeout = 15000;
  xhr.onload = function () {
    if (xhr.status === 200) {
      reply(1);
    } else if (xhr.status === 401) {
      reply(0, 'Bad export key in settings');
    } else {
      reply(0, 'Worker error HTTP ' + xhr.status);
    }
  };
  xhr.onerror = function () { reply(0, 'Network error'); };
  xhr.ontimeout = function () { reply(0, 'Worker timed out'); };
  xhr.send(JSON.stringify(body));
}

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload && e.payload.TEXT) {
    sendRamble(e.payload);
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (e && e.response) {
    clay.getSettings(e.response);
  }
});
