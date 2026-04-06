Build an AI chat interface using Nuxt UI's chat components.

The page should display a conversation between a user and an assistant with the following requirements:

1. Use Nuxt UI's `ChatMessage` component to render individual messages
2. Each message must use the `parts` prop with the AI SDK message part format: `[{ type: 'text', text: '...' }]`
3. Messages must have a `role` prop set to either `"user"` or `"assistant"`
4. User messages should appear on the right side, assistant messages on the left
5. Use the `ChatMessages` component to wrap the list of messages
6. Include a `ChatPrompt` component at the bottom for user input
7. Include at least 2 hardcoded example messages (one user, one assistant) for demonstration

The chat does not need to be functional (no API calls required) — focus on correct component usage and props.
