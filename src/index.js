const path = require('node:path');
const { AudioPlayerStatus } = require('@discordjs/voice');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField
} = require('discord.js');
require('dotenv').config();

const { registerCommands } = require('./commands');
const { runPreflightChecks } = require('./runtime/preflight');
const { GuildRadio } = require('./radio/GuildRadio');
const { Library } = require('./radio/Library');
const { PlaylistStore } = require('./radio/PlaylistStore');

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DISCONNECT_ROLE_ID,
  MUSIC_DIR = path.resolve(process.cwd(), 'music')
} = process.env;
const disconnectRoleId = DISCONNECT_ROLE_ID?.trim() ?? '';
const hasDisconnectRoleConfig = Boolean(disconnectRoleId);

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
  process.exit(1);
}

try {
  runPreflightChecks();
} catch {
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const library = new Library(MUSIC_DIR);
const playlistStore = new PlaylistStore(library);
const guildRadios = new Map();
const controlPanels = new Map();
const panelRefreshTimers = new Map();

const CONTROL_IDS = {
  PLAY: 'radio:play',
  PREV: 'radio:prev',
  SKIP: 'radio:skip',
  STOP: 'radio:stop',
  DISCONNECT: 'radio:disconnect',
  NOW: 'radio:now',
  RESCAN: 'radio:rescan'
};

async function safeRespond(interaction, payload) {
  try {
    if (interaction.deferred) {
      await interaction.editReply(payload);
      return;
    }
    if (interaction.replied) {
      await interaction.followUp(payload);
      return;
    }
    await interaction.reply(payload);
  } catch (err) {
    if (err?.code === 10062) {
      console.warn('Cannot respond: interaction token is no longer valid.');
      return;
    }
    throw err;
  }
}

function getOrCreateGuildRadio(guildId) {
  if (!guildRadios.has(guildId)) {
    const guildRadio = new GuildRadio({
      guildId,
      playlistStore,
      onDisconnected: (disconnectedGuildId) => {
        deleteControlPanelByGuild(disconnectedGuildId).catch(() => {});
      }
    });
    guildRadio.player.on('stateChange', () => {
      queuePanelRefresh(guildId);
    });
    guildRadios.set(guildId, guildRadio);
  }
  return guildRadios.get(guildId);
}

function getMemberVoiceChannel(interaction) {
  return interaction.member?.voice?.channel ?? null;
}

function hasRole(member, roleId) {
  if (!member || !roleId) {
    return false;
  }

  if (member.roles?.cache?.has?.(roleId)) {
    return true;
  }

  if (Array.isArray(member.roles)) {
    return member.roles.includes(roleId);
  }

  return false;
}

function getPlaybackStatus(guildRadio) {
  const status = guildRadio.player.state.status;
  if (status === AudioPlayerStatus.Playing) {
    return 'Playing';
  }
  if (status === AudioPlayerStatus.Paused) {
    return 'Paused';
  }
  return 'Stopped';
}

function buildPanelContent(guildRadio) {
  const now = guildRadio.nowPlaying();
  const nowLine = now ? `**${now.title}**` : 'Nothing';
  return `Radio control panel\nStatus: **${getPlaybackStatus(guildRadio)}**\nNow: ${nowLine}`;
}

function buildControlPanel(guildRadio) {
  const playLabel =
    guildRadio.player.state.status === AudioPlayerStatus.Playing ? '\u23F8 Pause' : '\u25B6 Play';
  const secondaryControls = [
    new ButtonBuilder().setCustomId(CONTROL_IDS.NOW).setLabel('\uD83C\uDFB5 Now').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(CONTROL_IDS.RESCAN).setLabel('\uD83D\uDD04 Rescan').setStyle(ButtonStyle.Secondary)
  ];
  if (hasDisconnectRoleConfig) {
    secondaryControls.push(
      new ButtonBuilder().setCustomId(CONTROL_IDS.DISCONNECT).setLabel('\uD83D\uDD0C Disconnect').setStyle(ButtonStyle.Danger)
    );
  }

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(CONTROL_IDS.PLAY).setLabel(playLabel).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(CONTROL_IDS.PREV).setLabel('\u23EE Prev').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(CONTROL_IDS.SKIP).setLabel('\u23ED Skip').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(CONTROL_IDS.STOP).setLabel('\u23F9 Stop').setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(...secondaryControls)
  ];
}

async function upsertControlPanel({ guildId, channel, guildRadio }) {
  if (!channel?.isTextBased?.()) {
    return null;
  }

  const payload = {
    content: buildPanelContent(guildRadio),
    components: buildControlPanel(guildRadio)
  };

  const existing = controlPanels.get(guildId);
  if (existing) {
    try {
      const targetChannel =
        existing.channelId === channel.id
          ? channel
          : await channel.guild.channels.fetch(existing.channelId);

      if (targetChannel?.isTextBased?.()) {
        const existingMessage = await targetChannel.messages.fetch(existing.messageId);
        return await existingMessage.edit(payload);
      }
    } catch {
      controlPanels.delete(guildId);
    }
  }

  const sent = await channel.send(payload);
  controlPanels.set(guildId, { channelId: channel.id, messageId: sent.id });
  return sent;
}

async function refreshControlPanelByGuild(guildId) {
  const panel = controlPanels.get(guildId);
  const guildRadio = guildRadios.get(guildId);
  if (!panel || !guildRadio) {
    return;
  }

  try {
    const channel = await client.channels.fetch(panel.channelId);
    if (!channel?.isTextBased?.()) {
      controlPanels.delete(guildId);
      return;
    }

    const message = await channel.messages.fetch(panel.messageId);
    await message.edit({
      content: buildPanelContent(guildRadio),
      components: buildControlPanel(guildRadio)
    });
  } catch {
    controlPanels.delete(guildId);
  }
}

async function deleteControlPanelByGuild(guildId) {
  const panel = controlPanels.get(guildId);
  controlPanels.delete(guildId);

  const timer = panelRefreshTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    panelRefreshTimers.delete(guildId);
  }

  if (!panel) {
    return;
  }

  try {
    const channel = await client.channels.fetch(panel.channelId);
    if (!channel?.isTextBased?.()) {
      return;
    }
    const message = await channel.messages.fetch(panel.messageId);
    await message.delete().catch(() => {});
  } catch {
    // Panel may already be deleted or channel unavailable.
  }
}

function queuePanelRefresh(guildId, delayMs = 150) {
  const previous = panelRefreshTimers.get(guildId);
  if (previous) {
    clearTimeout(previous);
  }

  const timer = setTimeout(() => {
    panelRefreshTimers.delete(guildId);
    refreshControlPanelByGuild(guildId).catch(() => {});
  }, delayMs);
  panelRefreshTimers.set(guildId, timer);
}

async function syncControlPanel(interaction, guildRadio) {
  try {
    await upsertControlPanel({
      guildId: interaction.guildId,
      channel: interaction.channel,
      guildRadio
    });
  } catch (err) {
    console.warn('Failed to update control panel:', err?.message ?? err);
  }
}

function canJoinAndSpeak(channel, member) {
  const me = channel.guild.members.me ?? member.client.user;
  const permissions = channel.permissionsFor(me);
  return (
    permissions?.has(PermissionsBitField.Flags.Connect) &&
    permissions?.has(PermissionsBitField.Flags.Speak)
  );
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await library.scan();
    console.log(`Library loaded with ${library.getTracks().length} track(s) from ${MUSIC_DIR}`);
    await registerCommands({ token: DISCORD_TOKEN, clientId: DISCORD_CLIENT_ID, guildId: DISCORD_GUILD_ID });
    console.log('Slash commands synced.');
  } catch (err) {
    console.error('Startup error:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await safeRespond(interaction, { content: 'This bot only works in servers.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guildRadio = getOrCreateGuildRadio(guildId);
    const memberVoiceChannel = getMemberVoiceChannel(interaction);

    try {
      switch (interaction.customId) {
        case CONTROL_IDS.PLAY: {
          if (!guildRadio.connection) {
            if (!memberVoiceChannel || memberVoiceChannel.type !== ChannelType.GuildVoice) {
              await safeRespond(interaction, { content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
              return;
            }
            if (!canJoinAndSpeak(memberVoiceChannel, interaction.member)) {
              await safeRespond(interaction, { content: 'I need Connect and Speak permission in your voice channel.', flags: MessageFlags.Ephemeral });
              return;
            }
            await guildRadio.join(memberVoiceChannel);
          }

          if (guildRadio.player.state.status === AudioPlayerStatus.Playing) {
            guildRadio.pause();
            await syncControlPanel(interaction, guildRadio);
            await safeRespond(interaction, { content: 'Paused.', flags: MessageFlags.Ephemeral });
            return;
          }

          if (guildRadio.player.state.status === AudioPlayerStatus.Paused) {
            guildRadio.resume();
            await syncControlPanel(interaction, guildRadio);
            await safeRespond(interaction, { content: 'Resumed.', flags: MessageFlags.Ephemeral });
            return;
          }

          const track = await guildRadio.playOrResume();
          if (!track) {
            const reason = guildRadio.getLastPlaybackError();
            const details = reason ? ` Reason: ${reason}` : '';
            await safeRespond(interaction, { content: `No playable tracks found. Add files and run /rescan.${details}`, flags: MessageFlags.Ephemeral });
            return;
          }

          await syncControlPanel(interaction, guildRadio);
          await safeRespond(interaction, { content: `Radio is on: **${path.basename(track)}**`, flags: MessageFlags.Ephemeral });
          return;
        }

        case CONTROL_IDS.SKIP: {
          const skipped = await guildRadio.skip();
          if (!skipped) {
            await safeRespond(interaction, { content: 'Nothing to skip right now.', flags: MessageFlags.Ephemeral });
            return;
          }

          await syncControlPanel(interaction, guildRadio);
          await safeRespond(interaction, { content: `Skipped: **${path.basename(skipped)}**`, flags: MessageFlags.Ephemeral });
          return;
        }

        case CONTROL_IDS.PREV: {
          const previous = await guildRadio.prev();
          if (!previous) {
            const reason = guildRadio.getLastPlaybackError();
            const details = reason ? ` Reason: ${reason}` : '';
            await safeRespond(interaction, { content: `No previous track available.${details}`, flags: MessageFlags.Ephemeral });
            return;
          }

          await syncControlPanel(interaction, guildRadio);
          await safeRespond(interaction, { content: `Back to: **${path.basename(previous)}**`, flags: MessageFlags.Ephemeral });
          return;
        }

        case CONTROL_IDS.STOP: {
          guildRadio.stop();
          await syncControlPanel(interaction, guildRadio);
          await safeRespond(interaction, { content: 'Playback stopped.', flags: MessageFlags.Ephemeral });
          return;
        }

        case CONTROL_IDS.NOW: {
          const now = guildRadio.nowPlaying();
          await syncControlPanel(interaction, guildRadio);
          await safeRespond(interaction, { content: now ? `Now playing: **${now.title}**` : 'Nothing is playing right now.', flags: MessageFlags.Ephemeral });
          return;
        }

        case CONTROL_IDS.RESCAN: {
          const tracks = await library.scan();
          await syncControlPanel(interaction, guildRadio);
          await safeRespond(interaction, { content: `Rescanned library. Found **${tracks.length}** track(s).`, flags: MessageFlags.Ephemeral });
          return;
        }

        case CONTROL_IDS.DISCONNECT: {
          if (!hasDisconnectRoleConfig) {
            await safeRespond(interaction, { content: 'Disconnect role is not configured. Set DISCONNECT_ROLE_ID in .env.', flags: MessageFlags.Ephemeral });
            return;
          }

          if (!hasRole(interaction.member, disconnectRoleId)) {
            await safeRespond(interaction, { content: 'You do not have permission to disconnect the bot.', flags: MessageFlags.Ephemeral });
            return;
          }

          if (!guildRadio.connection) {
            await safeRespond(interaction, { content: 'Bot is not connected to a voice channel.', flags: MessageFlags.Ephemeral });
            return;
          }

          guildRadio.leave();
          await safeRespond(interaction, { content: 'Bot disconnected from voice channel.', flags: MessageFlags.Ephemeral });
          return;
        }

        default:
          return;
      }
    } catch (err) {
      console.error(`Button ${interaction.customId} failed:`, err);
      await safeRespond(interaction, { content: 'Button action failed. Check bot logs.', flags: MessageFlags.Ephemeral });
      return;
    }
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'This bot only works in servers.', flags: MessageFlags.Ephemeral });
    return;
  }

  const memberVoiceChannel = getMemberVoiceChannel(interaction);
  const guildRadio = getOrCreateGuildRadio(guildId);

  try {
    switch (interaction.commandName) {
      case 'join': {
        if (!memberVoiceChannel || memberVoiceChannel.type !== ChannelType.GuildVoice) {
          await safeRespond(interaction, { content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!canJoinAndSpeak(memberVoiceChannel, interaction.member)) {
          await safeRespond(interaction, { content: 'I need Connect and Speak permission in your voice channel.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await guildRadio.join(memberVoiceChannel);
        await syncControlPanel(interaction, guildRadio);
        await safeRespond(interaction, { content: `Joined **${memberVoiceChannel.name}**. Control panel updated.` });
        return;
      }

      case 'radio': {
        if (!guildRadio.connection) {
          if (!memberVoiceChannel || memberVoiceChannel.type !== ChannelType.GuildVoice) {
            await safeRespond(interaction, { content: 'Join a voice channel first, or run /join.', flags: MessageFlags.Ephemeral });
            return;
          }

          if (!canJoinAndSpeak(memberVoiceChannel, interaction.member)) {
            await safeRespond(interaction, { content: 'I need Connect and Speak permission in your voice channel.', flags: MessageFlags.Ephemeral });
            return;
          }
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!guildRadio.connection) {
          await guildRadio.join(memberVoiceChannel);
        }

        const track = await guildRadio.playOrResume();
        if (!track) {
          const reason = guildRadio.getLastPlaybackError();
          const details = reason ? ` Reason: ${reason}` : '';
          await safeRespond(interaction, { content: `No playable tracks found. Add files and run /rescan.${details}` });
          return;
        }

        await syncControlPanel(interaction, guildRadio);
        await safeRespond(interaction, { content: `Radio is on: **${path.basename(track)}**. Control panel updated.` });
        return;
      }

      case 'panel': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await syncControlPanel(interaction, guildRadio);
        await safeRespond(interaction, { content: 'Control panel posted/updated in this channel.' });
        return;
      }

      case 'stop': {
        guildRadio.stop();
        await syncControlPanel(interaction, guildRadio);
        await safeRespond(interaction, 'Playback stopped.');
        return;
      }

      case 'skip': {
        const skipped = await guildRadio.skip();
        if (!skipped) {
          await safeRespond(interaction, { content: 'Nothing to skip right now.', flags: MessageFlags.Ephemeral });
          return;
        }

        await syncControlPanel(interaction, guildRadio);
        await safeRespond(interaction, `Skipped: **${path.basename(skipped)}**`);
        return;
      }

      case 'prev': {
        const previous = await guildRadio.prev();
        if (!previous) {
          const reason = guildRadio.getLastPlaybackError();
          const details = reason ? ` Reason: ${reason}` : '';
          await safeRespond(interaction, { content: `No previous track available.${details}`, flags: MessageFlags.Ephemeral });
          return;
        }

        await syncControlPanel(interaction, guildRadio);
        await safeRespond(interaction, `Back to: **${path.basename(previous)}**`);
        return;
      }

      case 'now': {
        const now = guildRadio.nowPlaying();
        await syncControlPanel(interaction, guildRadio);
        await safeRespond(interaction, now ? `Now playing: **${now.title}**` : 'Nothing is playing right now.');
        return;
      }

      case 'rescan': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tracks = await library.scan();
        await syncControlPanel(interaction, guildRadio);
        await safeRespond(interaction, `Rescanned library. Found **${tracks.length}** track(s).`);
        return;
      }

      default:
        await safeRespond(interaction, { content: 'Unknown command.', flags: MessageFlags.Ephemeral });
        return;
    }
  } catch (err) {
    console.error(`Command ${interaction.commandName} failed:`, err);
    const details = err?.message ? ` ${err.message}` : '';
    const payload = { content: `Command failed.${details}`, flags: MessageFlags.Ephemeral };
    try {
      await safeRespond(interaction, payload);
    } catch (responseErr) {
      console.error('Failed to send command error response:', responseErr);
    }
  }
});

client.on('error', (err) => {
  console.error('Discord client error:', err);
});

client.login(DISCORD_TOKEN);
