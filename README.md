# prompt-jump

A Claude Code mod for the fullscreen view: jump between your own messages with Ctrl+↑ / Ctrl+↓, and see where you are in the conversation.

- **Ctrl+↑ / Ctrl+↓** jump to your previous / next message, which gets an orange box. Ctrl+↓ past your last message goes back to the latest answer.
- **The pane on the right** lists your messages, one line each. A light block marks where you are, and clicking a line jumps there. `/messages` opens the pane again after you close it.
- **The key line** under the chat shows `ctrl+↑ prev · ctrl+↓ next · 13/24`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-jump --marketplace etombrof/prompt-jump
```

Answer `y` to add the marketplace, then press Enter to install for your user (every session).

From a shell:

```
claude plugin install prompt-jump --marketplace etombrof/prompt-jump
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `etombrof/prompt-jump`, then Add plugin.

## What it needs

- Claude Code's fullscreen view: `"tui": "fullscreen"` in `~/.claude/settings.json`.
- `python3`, to read your earlier messages from the session's transcript. Without it, only messages sent after the session starts are listed.
- A wide terminal for the pane to open by itself. In a narrow one, `/messages` opens it.

## Ctrl+↑ / Ctrl+↓ while you are typing

Claude's prompt box keeps Ctrl+↑/↓ for itself once it holds text, but lets Alt+↑/↓ through, and the mod answers both. In kitty, add this to `kitty.conf` so Ctrl+↑/↓ always work:

```
map ctrl+up   send_key alt+up
map ctrl+down send_key alt+down
```

This sends Alt+↑/↓ for Ctrl+↑/↓ in every program running in kitty.

## Known limits

- Two messages that start with the same 80 characters can be mixed up.
- After Claude's own big jumps (Ctrl+Home/End, a very fast scroll), the block takes about 0.3 s to catch up.
