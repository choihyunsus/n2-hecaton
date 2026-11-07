// Register concrete host capabilities before accepting model-selected calls.
module.exports = {
  tools: [
    {
      name: 'echo',
      version: '1',
      description: 'Return the supplied text',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 1000 } },
        required: ['text'],
        additionalProperties: false,
      },
      execute(args) {
        return { success: true, output: args.text };
      },
    },
  ],
};
