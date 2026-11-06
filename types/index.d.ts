// one of your messages, by its transcript id; null = none
export type MessageId = string | null

declare module 'claude-code' {
  interface PluginState {
    'prompt-jump': {
      selected: MessageId // the message Ctrl+Up/Down landed on; null = the normal view
      here: MessageId // the message the side pane's block is on
    }
  }
}
