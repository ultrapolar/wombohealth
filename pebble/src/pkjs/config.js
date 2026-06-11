// Clay configuration page: where the companion JS finds your Worker.
module.exports = [
  {
    type: 'heading',
    defaultValue: 'Wombo Health',
  },
  {
    type: 'text',
    defaultValue:
      'Shows your trmnl-health dashboard on the watch. Point it at your deployed Cloudflare Worker.',
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
    type: 'submit',
    defaultValue: 'Save',
  },
];
