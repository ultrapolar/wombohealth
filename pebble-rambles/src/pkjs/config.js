// Clay configuration page: same Worker + key as the health app.
module.exports = [
  {
    type: 'heading',
    defaultValue: 'Rambles',
  },
  {
    type: 'text',
    defaultValue:
      'Dictated notes go to your trmnl-health Worker, then into your Obsidian Rambles folder. ' +
      'Start a note with "to do", "important", "idea" or "question" to file it under that section.',
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
