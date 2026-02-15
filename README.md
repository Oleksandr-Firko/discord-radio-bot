# Discord Radio Bot

A modular Discord music bot that plays local audio files continuously in voice channels with looped playback.

## Features

- Local-file playback from `MUSIC_DIR` (no online streaming)
- FFmpeg-based decoding for common formats (`mp3`, `wav`, `ogg`, `flac`, `m4a`, `aac`, `opus`)
- Continuous play with loop-to-start behavior at end of list
- Per-guild playback state (multiple servers independently)
- Slash commands: `/join`, `/radio`, `/panel`, `/stop`, `/prev`, `/skip`, `/now`, `/rescan`
- Live control panel with buttons (Play/Pause, Prev, Skip, Stop, Now, Rescan)
- Role-restricted Disconnect button in control panel
- Fail-fast dependency checks on startup (DAVE, Opus, FFmpeg)
- Modular structure ready for future playlist expansion

## Project Structure

- `src/index.js`: bot startup, command handling, guild radio management
- `src/commands.js`: slash command definitions and registration
- `src/radio/Library.js`: scans `MUSIC_DIR` for audio files
- `src/radio/PlaylistStore.js`: playlist abstraction (currently returns full library)
- `src/radio/GuildRadio.js`: voice connection + playback loop per guild

## Requirements

- Node.js 18+
- Discord application + bot token
- FFmpeg available in `PATH`

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Install FFmpeg (Windows):

```powershell
winget install Gyan.FFmpeg
```

Then restart terminal and verify:

```bash
ffmpeg -version
```

3. Create `.env` in project root (or copy from `.env.example`):

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_GUILD_ID=optional_test_guild_id
DISCONNECT_ROLE_ID=optional_role_id_allowed_to_disconnect_bot
MUSIC_DIR=C:/absolute/path/to/your/music
```

- Use `DISCORD_GUILD_ID` for faster guild-scoped command updates while developing.
- Omit it to register global commands.
- Set `DISCONNECT_ROLE_ID` to restrict the Disconnect button to one role.

4. Install required voice codec dependencies:

```bash
pnpm add @snazzah/davey opusscript
```

5. Register slash commands:

```bash
pnpm run register
```

6. Start bot:

```bash
pnpm start
```

## Bot Permissions and Intents

- Intents used: `Guilds`, `GuildVoiceStates`
- Voice channel permissions required:
  - `Connect`
  - `Speak`

When inviting the bot, include these permissions.

## Commands

- `/join`: bot joins your current voice channel
- `/radio`: starts or continues playback
- `/panel`: posts or refreshes a single live control panel in the current channel
- `/stop`: stops playback (does not auto-skip to next track)
- `/prev`: plays previous track
- `/skip`: skips current track (advances to next)
- `/now`: shows current track title
- `/rescan`: rescans `MUSIC_DIR` for new files

## Control Panel

- The bot keeps one live control panel per server and edits it instead of posting new panels.
- Control panel is deleted automatically when bot disconnects from voice channel.
- Use `/panel` anytime to re-post or refresh panel in the current channel.
- Buttons:
  - `Play/Pause`: toggles playback state (`Play`/`Pause`/`Resume`)
  - `Prev`: plays previous track
  - `Skip`: plays next track
  - `Stop`: stops playback
  - `Now`: shows now playing
  - `Rescan`: rescans local music library
  - `Disconnect`: disconnects bot from voice channel (allowed role only, shown only if `DISCONNECT_ROLE_ID` is set)

## Startup Checks

On startup, bot runs dependency preflight and exits early if required runtime pieces are missing:

- `@snazzah/davey` (required by `@discordjs/voice@0.19.x`)
- Opus encoder (`@discordjs/opus` or `opusscript`)
- `ffmpeg` in `PATH` (or `FFMPEG_PATH` if set)

## Notes for Future Playlist Support

`PlaylistStore` is intentionally separated from playback logic. To add custom playlists later, update `PlaylistStore.getTracksForGuild(guildId)` without major changes to `GuildRadio`.

## Troubleshooting

- `No compatible encryption modes...`
  - Ensure `@discordjs/voice` is `0.19.x`.
- `Cannot utilize the DAVE protocol...`
  - Install `@snazzah/davey`.
- `FFmpeg/avconv not found!`
  - Make sure `ffmpeg -version` works in the same terminal where you run `pnpm start`.
- `Cannot find module '@discordjs/opus'` on Node 24
  - Use `opusscript` (already included in setup), or switch to Node 20/22 LTS and use `@discordjs/opus`.
