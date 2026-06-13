// Clay configuration page: Worker + key, plus timeline pin options.
module.exports = [
  {
    type: 'heading',
    defaultValue: 'Proton Cal',
  },
  {
    type: 'text',
    defaultValue:
      'Shows your Proton Calendar on the watch and pushes events into the system timeline. ' +
      'The Worker reads your Proton "share via link" ICS feed (set PROTON_ICS_URL on the Worker).',
  },
  {
    type: 'section',
    items: [
      {
        type: 'input',
        messageKey: 'workerUrl',
        label: 'Worker URL',
        attributes: {
          placeholder: 'https://your-worker.workers.dev',
          type: 'url',
        },
      },
      {
        type: 'input',
        messageKey: 'exportKey',
        label: 'Export key',
        attributes: {
          placeholder: 'EXPORT_KEY secret',
          type: 'text',
        },
      },
    ],
  },
  {
    type: 'section',
    items: [
      {
        type: 'toggle',
        messageKey: 'pushPins',
        label: 'Push timeline pins',
        defaultValue: true,
      },
      {
        type: 'input',
        messageKey: 'timelineApi',
        label: 'Timeline API',
        defaultValue: 'https://timeline-api.rebble.io',
        attributes: {
          type: 'url',
        },
      },
    ],
  },
  {
    type: 'submit',
    defaultValue: 'Save',
  },
];
